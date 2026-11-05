import { spawn } from "node:child_process";
import { DIRECT_SSH_OPTIONS, discoverRemoteAgent, listMachineAgents, listSavedMachines, resolveRemoteMachine, remoteCommandFor, validateRemoteCommand, type RemoteAgent, type SavedMachine } from "./cross-machine-discovery.ts";
import type { CrossMachineHostConfig } from "./config.ts";
import type { CrossMachineEnvelope, CrossMachineOrigin } from "./cross-machine-envelope.ts";

export const DELIVERY_TIMEOUT_MS = 15_000;

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut?: boolean;
}

export type CommandRunner = (command: string, args: string[], stdin?: string, timeoutMs?: number) => Promise<CommandResult>;

export interface CrossMachineDeps {
  run?: CommandRunner;
  herdrBin?: string;
  remoteCommand?: string;
  machines?: Record<string, CrossMachineHostConfig>;
  exactSessionId?: boolean;
  discoveryTimeoutMs?: number;
  deliveryTimeoutMs?: number;
}

export interface RemoteRoster {
  machines?: SavedMachine[];
  machine?: SavedMachine;
  agents?: RemoteAgent[];
}

export async function listRemotePeers(machineLabel?: string, deps: CrossMachineDeps = {}): Promise<RemoteRoster> {
  const discovery = { ...deps, run: deps.run ?? runCommand, herdrBin: deps.herdrBin ?? process.env.HERDR_BIN_PATH ?? "herdr" };
  if (!machineLabel) return { machines: await listSavedMachines(discovery) };
  const machine = await resolveRemoteMachine(machineLabel, discovery);
  return { machine, agents: await listMachineAgents(machine, discovery) };
}

export interface CrossMachineDelivery {
  machine: SavedMachine;
  agent: RemoteAgent;
  stdout: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const runCommand: CommandRunner = (command, args, input, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;
  let stdinError: Error | undefined;
  let stdinClosed = false;
  let exitCode: number | null | undefined;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    child.off("error", onError);
    child.off("close", onClose);
  };
  const onError = (error: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };
  const finish = () => {
    if (settled || exitCode === undefined || !stdinClosed) return;
    settled = true;
    if (stdinError && exitCode === 0 && !timedOut) {
      reject(stdinError);
      return;
    }
    resolve({ stdout, stderr, code: timedOut ? 124 : (exitCode ?? 1), ...(timedOut ? { timedOut: true } : {}) });
  };
  const onClose = (code: number | null) => {
    exitCode = code;
    cleanup();
    finish();
  };
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.on("error", onError);
  child.on("close", onClose);
  // stdin errors belong to the pipe, not the ChildProcess. Wait for both to
  // close so a late write error cannot turn incomplete input into success.
  child.stdin.on("error", (error) => { stdinError = error; });
  child.stdin.on("close", () => {
    stdinClosed = true;
    finish();
  });
  // Only this callback sees ECANCELED when stdin is destroyed without an 'error' event
  // (the child exits 0 while another process still holds the pipe).
  child.stdin.end(input, (error?: Error | null) => {
    if (error) stdinError ??= error;
  });
});

function relaySupportError(machine: string): Error {
  return new Error(`Remote pi-intercom on "${machine}" has no compatible relay support and needs upgrading.`);
}

export async function sendCrossMachine(
  target: string,
  text: string,
  origin: CrossMachineOrigin,
  deps: CrossMachineDeps = {},
): Promise<CrossMachineDelivery> {
  const run = deps.run ?? runCommand;
  const herdr = deps.herdrBin ?? process.env.HERDR_BIN_PATH ?? "herdr";
  const remoteCommand = validateRemoteCommand(deps.remoteCommand ?? "pi-intercom");
  const match = await discoverRemoteAgent(target, {
    run,
    herdrBin: herdr,
    remoteCommand,
    machines: deps.machines,
    exactSessionId: deps.exactSessionId,
    ...(deps.discoveryTimeoutMs === undefined ? {} : { discoveryTimeoutMs: deps.discoveryTimeoutMs }),
  });
  const envelope: CrossMachineEnvelope = { version: 1, target: match.agent.sessionId ?? match.agent.name, text, origin, trust: "ssh-asserted" };
  let delivered: CommandResult;
  try {
    delivered = await run(
      "ssh",
      [...DIRECT_SSH_OPTIONS, match.machine.target, `${remoteCommandFor(match.machine, { run, herdrBin: herdr, remoteCommand })} relay --envelope-stdin --json`],
      `${JSON.stringify(envelope)}\n`,
      deps.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS,
    );
  } catch (error) {
    throw new Error(`SSH relay via ${match.machine.label} failed: ${(error as Error).message}. Delivery outcome is unknown; do not automatically retry.`);
  }
  if (delivered.timedOut || delivered.code === 255) {
    throw new Error(`SSH relay via ${match.machine.label} ${delivered.timedOut ? "timed out" : `failed (exit ${delivered.code})`}: ${delivered.stderr.trim().slice(0, 1000)}. Delivery outcome is unknown; check SSH connectivity/host keys before an explicit retry.`);
  }
  let response: unknown;
  try {
    response = JSON.parse(delivered.stdout);
  } catch {
    throw new Error(`SSH relay via ${match.machine.label} returned no valid JSON (exit ${delivered.code}): ${delivered.stderr.trim().slice(0, 1000) || "empty or non-JSON response"}. Check the remote command/relay version. Delivery outcome is unknown; do not automatically retry.`);
  }
  if (!isRecord(response) || typeof response.ok !== "boolean" || ("version" in response && response.version !== 1)) {
    throw relaySupportError(match.machine.label);
  }
  if (delivered.code !== 0 || response.ok !== true) {
    if (typeof response.error !== "string") throw relaySupportError(match.machine.label);
    throw new Error(`Remote intercom delivery via ${match.machine.label} failed: ${response.error}`);
  }
  if (response.delivered !== true) throw new Error(`Remote intercom on ${match.machine.label} did not confirm delivery. Delivery outcome is unknown; do not automatically retry.`);
  return { ...match, stdout: delivered.stdout };
}
