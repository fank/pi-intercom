import test from "node:test";
import assert from "node:assert/strict";
import { DISCOVERY_TIMEOUT_MS, DIRECT_SSH_OPTIONS, discoverRemoteAgent, listMachineAgents, listSavedMachines, parseBrokerAgents, parseCrossMachineTarget, parseSavedMachines } from "./cross-machine-discovery.ts";
import type { CommandRunner } from "./cross-machine-transport.ts";

const id = "00000000-0000-4000-8000-000000000001";
const machines = [{ label: "Workstation", target: "user@workstation.example", enabled: true }, { label: "disabled", target: "disabled.example", enabled: false }];
const peer = { name: "subagent-chat-00000000-0000-4000", id, model: "test-model", status: "working", cwd: "/repo/llaminar" };
const roster = (rows = [peer]) => JSON.stringify({ ok: true, sessions: rows });
function deps(rows = [peer], saved = machines) {
  const calls: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
  const run: CommandRunner = async (command, args, _stdin, timeoutMs) => {
    calls.push({ command, args, timeoutMs });
    if (command === "herdr") {
      assert.deepEqual(args, ["machine", "list", "--json"], "pane discovery must not be used for identity");
      return { code: 0, stdout: JSON.stringify(saved), stderr: "" };
    }
    return { code: 0, stdout: roster(rows), stderr: "" };
  };
  return { run, herdrBin: "herdr", remoteCommand: "pi-intercom", calls };
}

test("explicit address parser supports aliases and arbitrary full stable broker IDs", () => {
  for (const target of ["worker@Workstation", `${id}@Workstation`, "custom-stable-id@Workstation"]) assert.doesNotThrow(() => parseCrossMachineTarget(target));
  for (const target of ["worker", "@host", "worker@", "worker@@host", " worker@host", "worker@ho\tst", "worker@ho\0st"]) assert.throws(() => parseCrossMachineTarget(target), /expected alias@machine/);
});

test("saved-machine parser handles supported Herdr wrappers and fails closed on malformed rows", () => {
  assert.deepEqual(parseSavedMachines(JSON.stringify({result:{machines}})), machines);
  for (const value of ["invalid", "{}", '[{"label":"a","target":"x","enabled":"false"}]']) assert.throws(() => parseSavedMachines(value));
});

test("broker roster preserves actual aliases, stable IDs, cwd and status, excluding transient CLIs", () => {
  assert.deepEqual(parseBrokerAgents(roster([peer, { ...peer, id: "cli", model: "pi-intercom-cli" }])), [{ name: peer.name, sessionId: id, status: "working", cwd: "/repo/llaminar" }]);
  assert.equal(parseBrokerAgents(roster([{...peer, id:"stable-worker"}]))[0]!.sessionId, "stable-worker");
  for (const value of ["", "{}", '{"ok":true,"sessions":[{}]}', '{"ok":false,"error":"broker unavailable"}']) assert.throws(() => parseBrokerAgents(value));
});

test("unnamed and differently named panes do not override actual runtime aliases", async () => {
  const d = deps();
  assert.equal((await discoverRemoteAgent(`${peer.name}@workstation`, d)).agent.sessionId, id);
  await assert.rejects(discoverRemoteAgent("llaminar@workstation", d), /Candidates:.*subagent-chat.*list-remote/);
  assert.ok(d.calls.filter(call => call.command === "herdr").every(call => call.args[0] === "machine"));
});

test("only the selected machine's broker is queried with bounded noninteractive SSH", async () => {
  const d = deps();
  const match = await discoverRemoteAgent(`${peer.name.toUpperCase()}@workstation`, d);
  assert.equal(match.machine.label, "Workstation");
  assert.deepEqual(d.calls[1]!.args, [...DIRECT_SSH_OPTIONS, machines[0]!.target, "pi-intercom list --json"]);
  assert.ok(d.calls.every(call => call.timeoutMs === DISCOVERY_TIMEOUT_MS));
});

test("unknown, disabled and duplicate machine labels fail before any SSH attempt", async () => {
  for (const [target, saved] of [["worker@unknown", machines], ["worker@disabled", machines], ["worker@workstation", [...machines, {...machines[0]!, label:"WORKSTATION"}]]] as const) {
    const d = deps([peer], [...saved]);
    await assert.rejects(discoverRemoteAgent(target, d), /unknown or disabled|ambiguous/);
    assert.equal(d.calls.filter(call => call.command === "ssh").length, 0);
  }
});

test("duplicate broker aliases are ambiguous; full broker IDs take precedence even over alias collisions", async () => {
  const d = deps([{...peer,name:"worker"},{...peer,name:"WORKER",id:"stable-worker"},{...peer,name:id,id:"another"}]);
  await assert.rejects(discoverRemoteAgent("worker@workstation", d), /ambiguous.*stable-worker/);
  assert.equal((await discoverRemoteAgent(`${id}@workstation`, d)).agent.sessionId,id);
  assert.equal((await discoverRemoteAgent("stable-worker@workstation", d)).agent.sessionId,"stable-worker");
  await assert.rejects(discoverRemoteAgent(`${id.slice(0,8)}@workstation`,d), /No live broker peer exactly matches/);
});

test("without Herdr only explicitly configured destinations are allowed", async () => {
  const d = deps();
  const run: CommandRunner = async (command, ...args) => {
    if (command === "herdr") throw Object.assign(new Error("ENOENT"),{code:"ENOENT"});
    return d.run(command,...args);
  };
  await assert.rejects(discoverRemoteAgent(`${peer.name}@buildbox`,{...d,run}), /unknown or disabled/);
  const match = await discoverRemoteAgent(`${peer.name}@buildbox`,{...d,run,machines:{buildbox:{target:"user@buildbox",remoteCommand:"/opt/node /opt/intercom/cli.mjs"}}});
  assert.equal(match.machine.target,"user@buildbox");
  assert.equal(d.calls.at(-1)!.args.at(-1),"/opt/node /opt/intercom/cli.mjs list --json");
});

test("configured overrides retain disabled-machine protection and enumeration makes no remote connections", async () => {
  const d = deps();
  const result = await listSavedMachines({...d,machines:{disabled:{enabled:true,remoteCommand:"/opt/intercom"}}});
  assert.equal(result.find(machine=>machine.label === "disabled")!.enabled,false);
  assert.equal(d.calls.length,1);
});

test("SSH host-key, auth and timeout failures retain diagnostics rather than becoming upgrade errors", async () => {
  for (const failure of [{code:255,stderr:"Host key verification failed.",stdout:""},{code:124,stderr:"",stdout:"",timedOut:true}]) {
    const d = deps();
    const run: CommandRunner = async (cmd,...args) => cmd === "herdr" ? d.run(cmd,...args) : failure;
    await assert.rejects(discoverRemoteAgent(`${peer.name}@workstation`,{...d,run}), /Host key verification failed|timed out/);
  }
});

test("unsafe SSH targets and remote commands are rejected before SSH", async () => {
  for (const target of ["-oProxyCommand=bad","x\ny"," user@host"]) {
    const d = deps([peer],[{...machines[0]!,target}]);
    await assert.rejects(discoverRemoteAgent(`${peer.name}@workstation`,d), /unsafe SSH target/);
    assert.equal(d.calls.length,1);
  }
  const d = deps();
  await assert.rejects(listMachineAgents(machines[0]!,{...d,remoteCommand:"pi-intercom\ncommand"}), /ASCII control/);
  assert.equal(d.calls.length,0);
});
