import { execFileSync } from "node:child_process";

interface ProcessIdentity {
  readonly parentPid: number;
  readonly pid: number;
  readonly startedAt: string;
  readonly terminal: string;
}

type GuardianRequest =
  | { readonly requestId: string; readonly type: "register"; readonly shellPid: number }
  | {
      readonly requestId: string;
      readonly timeoutMilliseconds: number;
      readonly type: "renew";
    }
  | { readonly type: "unregister"; readonly shellPid: number }
  | { readonly type: "close" };

const leaseTimeoutMilliseconds = positiveInteger(
  Number.parseInt(process.env.ITERM_GUARDIAN_LEASE_TIMEOUT_MS ?? "", 10),
  "ITERM_GUARDIAN_LEASE_TIMEOUT_MS",
);
const terminationGraceMilliseconds = positiveInteger(
  Number.parseInt(process.env.ITERM_GUARDIAN_TERMINATION_GRACE_MS ?? "", 10),
  "ITERM_GUARDIAN_TERMINATION_GRACE_MS",
);
const registrations = new Map<number, ProcessIdentity>();
let deadline: NodeJS.Timeout | undefined;
let exitAfterReclaim = false;
let pendingRenewalMilliseconds: number | undefined;
let reclaiming = false;

process.on("message", (message: unknown) => {
  if (!isGuardianRequest(message)) return;
  if (message.type === "register") {
    try {
      if (reclaiming) throw new Error("Process Guardian is reclaiming an expired owner");
      const identity = processIdentity(message.shellPid);
      if (identity === undefined || identity.terminal === "?" || identity.terminal === "??") {
        throw new Error("Shell PTY process identity is unavailable");
      }
      registrations.set(message.shellPid, identity);
      acknowledge(message.requestId);
    } catch (error) {
      acknowledge(message.requestId, errorMessage(error));
    }
    return;
  }
  if (message.type === "renew") {
    if (reclaiming) pendingRenewalMilliseconds = message.timeoutMilliseconds;
    else armDeadline(message.timeoutMilliseconds);
    acknowledge(message.requestId);
    return;
  }
  if (message.type === "unregister") {
    registrations.delete(message.shellPid);
    return;
  }
  exitAfterReclaim = true;
  clearDeadline();
  reclaim("guardian_close");
});

process.on("disconnect", () => {
  exitAfterReclaim = true;
  clearDeadline();
  reclaim("parent_disconnect");
});

function armDeadline(timeoutMilliseconds = leaseTimeoutMilliseconds): void {
  clearDeadline();
  deadline = setTimeout(() => reclaim("lease_timeout"), timeoutMilliseconds);
}

function clearDeadline(): void {
  if (deadline !== undefined) clearTimeout(deadline);
  deadline = undefined;
}

function reclaim(reason: "guardian_close" | "lease_timeout" | "parent_disconnect"): void {
  if (reclaiming) return;
  reclaiming = true;
  clearDeadline();
  const members = new Map<number, ProcessIdentity>();
  let registeredSessions = 0;
  for (const registration of registrations.values()) {
    if (!sameProcess(registration)) continue;
    registeredSessions += 1;
    for (const member of processTree(registration.pid)) members.set(member.pid, member);
    for (const member of terminalMembers(registration.terminal)) members.set(member.pid, member);
    members.set(registration.pid, registration);
  }
  for (const member of members.values()) signalIfCurrent(member, "SIGSTOP");
  for (const member of members.values()) signalIfCurrent(member, "SIGTERM");
  setTimeout(() => {
    for (const member of members.values()) signalIfCurrent(member, "SIGKILL");
    registrations.clear();
    if (reason === "lease_timeout" || registeredSessions > 0) {
      emitEvent({
        event: "reclaimed",
        processCount: members.size,
        reason,
        registeredSessions,
      });
    }
    reclaiming = false;
    if (exitAfterReclaim || !process.connected) {
      process.exit(0);
      return;
    }
    if (pendingRenewalMilliseconds !== undefined) {
      const timeoutMilliseconds = pendingRenewalMilliseconds;
      pendingRenewalMilliseconds = undefined;
      armDeadline(timeoutMilliseconds);
    }
  }, terminationGraceMilliseconds);
}

function processIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  const parentPid = integerPsValue(["-o", "ppid=", "-p", pid.toString()]);
  const startedAt = textPsValue(["-o", "lstart=", "-p", pid.toString()]);
  const terminal = textPsValue(["-o", "tty=", "-p", pid.toString()]);
  if (parentPid === undefined || startedAt === undefined || terminal === undefined)
    return undefined;
  return { parentPid, pid, startedAt, terminal };
}

function processTree(rootPid: number): readonly ProcessIdentity[] {
  let output: string;
  try {
    output = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 2_000,
    });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const parentPid = Number.parseInt(match[2] ?? "", 10);
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }
  const members: ProcessIdentity[] = [];
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined || pid === process.pid) continue;
    pending.push(...(children.get(pid) ?? []));
    const identity = processIdentity(pid);
    if (identity !== undefined) members.unshift(identity);
  }
  return members;
}

function terminalMembers(terminal: string): readonly ProcessIdentity[] {
  let output: string;
  try {
    output = execFileSync("ps", ["-axo", "pid=,tty="], {
      encoding: "utf8",
      timeout: 2_000,
    });
  } catch {
    return [];
  }
  const members: ProcessIdentity[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (match === null || match[2] !== terminal) continue;
    const identity = processIdentity(Number.parseInt(match[1] ?? "", 10));
    if (identity !== undefined && identity.terminal === terminal) members.push(identity);
  }
  return members;
}

function sameProcess(identity: ProcessIdentity): boolean {
  const current = processIdentity(identity.pid);
  return current !== undefined && current.startedAt === identity.startedAt;
}

function signalIfCurrent(identity: ProcessIdentity, signal: NodeJS.Signals): void {
  if (!sameProcess(identity)) return;
  try {
    process.kill(identity.pid, signal);
  } catch {
    // A process that exited between identity validation and signal delivery is already reclaimed.
  }
}

function integerPsValue(args: readonly string[]): number | undefined {
  const value = textPsValue(args);
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function textPsValue(args: readonly string[]): string | undefined {
  try {
    const value = execFileSync("ps", [...args], { encoding: "utf8", timeout: 2_000 }).trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

function acknowledge(requestId: string, error?: string): void {
  if (!process.connected) return;
  process.send?.({
    type: "ack",
    requestId,
    ...(error === undefined ? {} : { error }),
  });
}

function emitEvent(event: {
  readonly event: "reclaimed";
  readonly processCount: number;
  readonly reason: string;
  readonly registeredSessions: number;
}): void {
  if (!process.connected) return;
  process.send?.({ type: "event", ...event });
}

function isGuardianRequest(value: unknown): value is GuardianRequest {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const type = value.type;
  if (type === "close") return true;
  if (type === "unregister") {
    return "shellPid" in value && isIntegerAboveOne(value.shellPid);
  }
  if (type !== "register" && type !== "renew") return false;
  if (!("requestId" in value) || typeof value.requestId !== "string") return false;
  if (type === "renew") {
    return (
      "timeoutMilliseconds" in value &&
      isPositiveInteger(value.timeoutMilliseconds) &&
      value.timeoutMilliseconds <= leaseTimeoutMilliseconds
    );
  }
  return "shellPid" in value && isIntegerAboveOne(value.shellPid);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isIntegerAboveOne(value: unknown): value is number {
  return isPositiveInteger(value) && value > 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
