import test from "node:test";
import assert from "node:assert/strict";
import { DISCOVERY_TIMEOUT_MS } from "./cross-machine-discovery.ts";
import {
  DELIVERY_TIMEOUT_MS,
  runCommand,
  sendCrossMachine,
  type CommandRunner,
} from "./cross-machine-transport.ts";

const fakeSessionId = "00000000-0000-4000-8000-000000000001";
const machines = JSON.stringify([{ label: "workstation", target: "workstation.example", enabled: true }]);
const origin = { name: "worker", sessionId: fakeSessionId, machine: "laptop" };
const intercomList = JSON.stringify({ ok: true, sessions: [{ name: "reviewer", id: fakeSessionId, model: "m", cwd: "/" }] });

function discoveryResult(command: string, args: string[]) {
  if (args[0] === "machine") return { code: 0, stdout: machines, stderr: "" };
  if (command === "ssh" && args.at(-1)?.endsWith(" list --json")) return { code: 0, stdout: intercomList, stderr: "" };
  return undefined;
}

test("broker alias discovery and relay use the same trusted command and saved target", async () => {
  const calls: Array<{ command: string; args: string[]; stdin?: string; timeoutMs?: number }> = [];
  const run: CommandRunner = async (command, args, stdin, timeoutMs) => {
    calls.push({command,args,stdin,timeoutMs});
    return discoveryResult(command,args) ?? {code:0,stdout:'{"ok":true,"delivered":true}',stderr:""};
  };
  const text = 'hello; $(touch /tmp/nope)\n"quoted" && exit 9';
  const command = "/opt/node /opt/intercom/cli.mjs";
  const result = await sendCrossMachine("reviewer@workstation",text,origin,{run,herdrBin:"herdr",remoteCommand:"pi-intercom",machines:{workstation:{remoteCommand:command}}});
  assert.equal(result.agent.name,"reviewer");
  const ssh = calls.filter(call=>call.command === "ssh");
  assert.deepEqual(ssh.map(call=>call.args),[
    ["-o","BatchMode=yes","-o","ConnectTimeout=5","workstation.example",command+" list --json"],
    ["-o","BatchMode=yes","-o","ConnectTimeout=5","workstation.example",command+" relay --envelope-stdin --json"],
  ]);
  const wire = JSON.parse(ssh[1]!.stdin!);
  assert.equal(wire.target,fakeSessionId);
  assert.deepEqual(wire.origin,origin);
  assert.equal(wire.text,text);
  assert.equal(ssh.some(call=>call.args.some(arg=>arg.includes(text))),false);
  assert.equal(ssh[0]!.timeoutMs,DISCOVERY_TIMEOUT_MS);
  assert.equal(ssh[1]!.timeoutMs,DELIVERY_TIMEOUT_MS);
});

test("unknown destinations do not silently fall back to arbitrary SSH hosts", async () => {
  const calls: string[] = [];
  const run: CommandRunner = async (command,args) => { calls.push(command); return discoveryResult(command,args)!; };
  await assert.rejects(sendCrossMachine("reviewer@typo","hi",origin,{run,herdrBin:"herdr"}),/unknown or disabled/);
  assert.deepEqual(calls,["herdr"]);
});

test("rejects empty or control-character remote commands before invoking SSH", async () => {
  for (const remoteCommand of ["", "   ", "pi-intercom\0--bad", "pi-intercom\t--bad", "pi-intercom\x1f--bad", "pi-intercom\x7f--bad"]) {
    const calls: string[] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push(command);
      return discoveryResult(command, args) ?? { code: 0, stdout: '{"ok":true}', stderr: "" };
    };
    await assert.rejects(
      sendCrossMachine("reviewer@workstation", "hi", origin, { run, herdrBin: "herdr", remoteCommand }),
      /Remote command must (not be empty|not contain ASCII control characters)/,
    );
    assert.equal(calls.includes("ssh"), false);
  }
});

test("runCommand returns an awaitable timeout result after terminating its child", async () => {
  const started = Date.now();
  const result = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], undefined, 30);
  assert.deepEqual(result, { stdout: "", stderr: "", code: 124, timedOut: true });
  assert.ok(Date.now() - started < 2_000, "timed-out child should be reaped promptly");
});

test("runCommand rejects once when spawning fails", async () => {
  await assert.rejects(runCommand("/definitely/not/a/command", [], undefined, 100), /ENOENT/);
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("runCommand delivers all stdin to a reading child", async () => {
  const input = "hello π\n".repeat(32 * 1024);
  const result = await runCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], input, 5_000);
  assert.deepEqual(result, { stdout: input, stderr: "", code: 0 });
});

test("runCommand preserves diagnostics when a failing child closes stdin early", async () => {
  const result = await runCommand(process.execPath, ["-e", `
    require("node:fs").closeSync(0);
    process.stdout.write('{"ok":false,"error":"relay unavailable"}');
    process.stderr.write("relay unavailable");
    process.exitCode = 7;
  `], "x".repeat(1024 * 1024), 5_000);
  assert.deepEqual(result, {
    stdout: '{"ok":false,"error":"relay unavailable"}',
    stderr: "relay unavailable",
    code: 7,
  });
});

test("runCommand rejects incomplete stdin even when the child exits successfully", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", 'require("node:fs").closeSync(0)'], "x".repeat(1024 * 1024), 5_000),
    /EPIPE|EOF|ECONNRESET|closed|destroyed/i,
  );
});

test("runCommand still reaps a child that closes stdin and then times out", async () => {
  const result = await runCommand(process.execPath, ["-e", `
    require("node:fs").closeSync(0);
    process.stderr.write("stdin closed");
    setTimeout(() => process.exit(8), 10_000);
  `], "x".repeat(1024 * 1024), 1_000);
  assert.deepEqual(result, { stdout: "", stderr: "stdin closed", code: 124, timedOut: true });
});

test("SSH failures and non-JSON relay responses preserve diagnostics and unknown outcomes", async () => {
  for (const response of [
    {code:255,stdout:"",stderr:"Host key verification failed."},
    {code:124,stdout:"",stderr:"",timedOut:true},
    {code:127,stdout:"",stderr:"pi-intercom: command not found"},
  ]) {
    const run: CommandRunner = async (command,args) => discoveryResult(command,args) ?? response;
    await assert.rejects(sendCrossMachine("reviewer@workstation","hi",origin,{run,herdrBin:"herdr"}), /Delivery outcome is unknown/);
  }
});

test("incompatible JSON relay output reports the version problem, and ok alone is not delivery", async () => {
  for (const stdout of ['{"ok":"yes"}','{"version":2,"ok":true}']) {
    const run: CommandRunner = async (command,args) => discoveryResult(command,args) ?? {code:0,stdout,stderr:""};
    await assert.rejects(sendCrossMachine("reviewer@workstation","hi",origin,{run,herdrBin:"herdr"}), /no compatible relay support/);
  }
  const run: CommandRunner = async (command,args) => discoveryResult(command,args) ?? {code:0,stdout:'{"ok":true,"delivered":false}',stderr:""};
  await assert.rejects(sendCrossMachine("reviewer@workstation","hi",origin,{run,herdrBin:"herdr"}), /did not confirm delivery/);
});

test("structured remote failure preserves the reported error", async () => {
  const run: CommandRunner = async (command, args) => discoveryResult(command, args) ?? {
    code: 1,
    stdout: JSON.stringify({ ok: false, error: "target rejected the envelope version" }),
    stderr: "",
  };
  await assert.rejects(
    sendCrossMachine("reviewer@workstation", "hi", origin, { run, herdrBin: "herdr" }),
    /Remote intercom delivery via workstation failed: target rejected the envelope version/,
  );
});
