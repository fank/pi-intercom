import type { CrossMachineHostConfig } from "./config.ts";

export const DISCOVERY_TIMEOUT_MS = 5_000;
// Preserve normal SSH host-key verification; prompts must not take over Pi's terminal.
export const DIRECT_SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];

export interface SavedMachine {
  label: string;
  target: string;
  enabled: boolean;
  remoteCommand?: string;
}

export interface RemoteAgent {
  name: string;
  /** Actual intercom broker identity, not a Herdr session-file UUID. */
  sessionId?: string;
  cwd?: string;
  status?: string;
}

export interface DiscoveredRemoteAgent {
  machine: SavedMachine;
  agent: RemoteAgent;
}

export interface DiscoveryDeps {
  run: (command: string, args: string[], stdin?: string, timeoutMs?: number) => Promise<{
    stdout: string;
    stderr: string;
    code: number;
    timedOut?: boolean;
  }>;
  herdrBin: string;
  remoteCommand?: string;
  machines?: Record<string, CrossMachineHostConfig>;
  /** Internal origin-pinned replies must never fall back to a matching alias. */
  exactSessionId?: boolean;
  discoveryTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateRemoteCommand(command: string): string {
  if (!command.trim()) throw new Error("Remote command must not be empty.");
  if (/[\x00-\x1f\x7f]/.test(command)) throw new Error("Remote command must not contain ASCII control characters.");
  return command;
}

export function parseSavedMachines(raw: string): SavedMachine[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("herdr machine list returned invalid JSON.");
  }
  if (isRecord(value) && "result" in value) value = value.result;
  const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.machines) ? value.machines : undefined;
  if (!rows) throw new Error("herdr machine list returned an unsupported machine roster.");
  return rows.map((row): SavedMachine => {
    if (!isRecord(row) || typeof row.label !== "string" || !row.label || typeof row.target !== "string" || !row.target
      || (row.enabled !== undefined && typeof row.enabled !== "boolean")) {
      throw new Error("herdr machine list returned an invalid saved machine.");
    }
    return { label: row.label, target: row.target, enabled: row.enabled !== false };
  });
}

export function parseCrossMachineTarget(target: string): { agentTarget: string; machineLabel: string } {
  const parts = target.split("@");
  if (parts.length !== 2 || parts.some((part) => !part || /[\s\x00-\x1f\x7f]/.test(part))) {
    throw new Error(`Invalid remote target "${target}"; expected alias@machine or full-session-id@machine. Run list-remote first.`);
  }
  return { agentTarget: parts[0]!, machineLabel: parts[1]! };
}

/** List trusted destinations, without contacting any remote host. */
export async function listSavedMachines(deps: DiscoveryDeps): Promise<SavedMachine[]> {
  let machines: SavedMachine[];
  try {
    const listed = await deps.run(deps.herdrBin, ["machine", "list", "--json"], undefined, deps.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS);
    if (listed.code !== 0) throw new Error(`Could not list Herdr saved machines: ${listed.timedOut ? "timed out" : listed.stderr.trim() || `exit ${listed.code}`}`);
    machines = parseSavedMachines(listed.stdout);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    machines = [];
  }
  for (const [label, settings] of Object.entries(deps.machines ?? {})) {
    const matches = machines.filter(machine => machine.label.toLowerCase() === label.toLowerCase());
    if (matches.length > 1) throw new Error(`Saved Herdr machine label "${label}" is ambiguous.`);
    const existing = matches[0];
    if (existing) {
      // A disabled Herdr entry cannot be re-enabled implicitly by an override.
      existing.enabled = existing.enabled && settings.enabled !== false;
      if (settings.target) existing.target = settings.target;
      if (settings.remoteCommand) existing.remoteCommand = settings.remoteCommand;
    } else if (settings.target) {
      machines.push({ label, target: settings.target, enabled: settings.enabled !== false, ...(settings.remoteCommand ? { remoteCommand: settings.remoteCommand } : {}) });
    }
  }
  return machines;
}

export async function resolveRemoteMachine(label: string, deps: DiscoveryDeps): Promise<SavedMachine> {
  const selected = (await listSavedMachines(deps)).filter(machine => machine.label.toLowerCase() === label.toLowerCase());
  if (selected.length > 1) throw new Error(`Saved Herdr machine label "${label}" is ambiguous; expected exactly one machine.`);
  const machine = selected[0];
  if (!machine || !machine.enabled) {
    throw new Error(`Remote machine "${label}" is unknown or disabled. Run intercom({ action: "list-remote" }) to see configured machines; configure a Herdr saved machine or crossMachine.machines before sending.`);
  }
  if (/^[\s-]|[\x00-\x20\x7f]/.test(machine.target)) throw new Error(`Remote machine "${label}" has an unsafe SSH target.`);
  return machine;
}

/** Accept the existing list --json protocol, including older destination CLIs. */
export function parseBrokerAgents(raw: string): RemoteAgent[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Remote intercom list returned invalid JSON; check the remote command and upgrade pi-intercom if needed."); }
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.sessions)) {
    throw new Error(isRecord(value) && typeof value.error === "string" ? value.error : "Remote intercom list returned an unsupported broker roster.");
  }
  return value.sessions.flatMap((row): RemoteAgent[] => {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id || typeof row.model !== "string") throw new Error("Remote intercom list returned an invalid session.");
    if (row.model === "pi-intercom-cli") return [];
    return [{
      name: typeof row.name === "string" && row.name && row.name !== "(unnamed)" ? row.name : row.id,
      sessionId: row.id,
      ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
      ...(typeof row.status === "string" ? { status: row.status } : {}),
    }];
  });
}

export function remoteCommandFor(machine: SavedMachine, deps: DiscoveryDeps): string {
  return validateRemoteCommand(machine.remoteCommand ?? deps.remoteCommand ?? "pi-intercom");
}

export async function listMachineAgents(machine: SavedMachine, deps: DiscoveryDeps): Promise<RemoteAgent[]> {
  if (!machine.enabled) throw new Error(`Remote machine "${machine.label}" is disabled.`);
  if (/^[\s-]|[\x00-\x20\x7f]/.test(machine.target)) throw new Error(`Remote machine "${machine.label}" has an unsafe SSH target.`);
  const command = remoteCommandFor(machine, deps);
  const result = await deps.run("ssh", [...DIRECT_SSH_OPTIONS, machine.target, `${command} list --json`], undefined, deps.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS);
  if (result.code !== 0 || result.timedOut) {
    const detail = result.timedOut ? "timed out" : result.stderr.trim().slice(0, 1000) || `exit ${result.code}`;
    throw new Error(`Could not list intercom sessions on "${machine.label}" over SSH: ${detail}. Check SSH connectivity/host keys and crossMachine remoteCommand; no message was sent.`);
  }
  try { return parseBrokerAgents(result.stdout); } catch (error) {
    throw new Error(`Could not list intercom sessions on "${machine.label}": ${(error as Error).message}`);
  }
}

export function remoteCandidates(agents: RemoteAgent[], machine: string): string {
  if (agents.length === 0) return "No live broker peers in the destination pool.";
  return agents.slice(0, 8).map(agent => `${JSON.stringify(`${agent.name}@${machine}`)} (${agent.status ?? "unknown"}, cwd ${JSON.stringify(agent.cwd ?? "unknown")}, full ID ${JSON.stringify(agent.sessionId)})`).join("; ")
    + (agents.length > 8 ? "; … run list-remote for more" : "");
}

export async function discoverRemoteAgent(target: string, deps: DiscoveryDeps): Promise<DiscoveredRemoteAgent> {
  const explicit = parseCrossMachineTarget(target);
  const machine = await resolveRemoteMachine(explicit.machineLabel, deps);
  const agents = await listMachineAgents(machine, deps);
  // Full broker IDs take precedence, including non-UUID stable IDs. Never route by a pane label.
  const byId = agents.filter(agent => agent.sessionId === explicit.agentTarget);
  const matches = byId.length || deps.exactSessionId ? byId : agents.filter(agent => agent.name.toLowerCase() === explicit.agentTarget.toLowerCase());
  if (matches.length !== 1) {
    const reason = matches.length ? "Multiple live broker peers match; target is ambiguous" : "No live broker peer exactly matches";
    throw new Error(`${reason} ${JSON.stringify(target)}. Candidates: ${remoteCandidates(matches.length ? matches : agents, machine.label)}. Run intercom({ action: "list-remote", machine: ${JSON.stringify(machine.label)} }); use a listed alias (or a full broker ID to disambiguate).`);
  }
  return { machine, agent: matches[0]! };
}
