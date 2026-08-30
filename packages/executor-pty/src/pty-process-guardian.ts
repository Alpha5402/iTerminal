import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface PtyProcessGuardianEvent {
  readonly processCount: number;
  readonly reason: "guardian_close" | "lease_timeout" | "parent_disconnect";
  readonly registeredSessions: number;
  readonly type: "reclaimed";
}

export interface PtyProcessGuardianOptions {
  readonly leaseTimeoutMilliseconds: number;
  readonly onEvent?: (event: PtyProcessGuardianEvent) => void;
  readonly onFailure?: (error: Error) => void;
  readonly terminationGraceMilliseconds?: number;
}

export interface ShellProcessGuardian {
  register(shellPid: number): Promise<void>;
  unregister(shellPid: number): void;
}

interface PendingRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
  readonly timer: NodeJS.Timeout;
}

interface GuardianAck {
  readonly error?: string;
  readonly requestId: string;
  readonly type: "ack";
}

interface GuardianEventMessage {
  readonly event: "reclaimed";
  readonly processCount: number;
  readonly reason: PtyProcessGuardianEvent["reason"];
  readonly registeredSessions: number;
  readonly type: "event";
}

const REQUEST_TIMEOUT_MILLISECONDS = 5_000;

export class PtyProcessGuardian implements ShellProcessGuardian {
  readonly #child: ChildProcess;
  readonly #leaseTimeoutMilliseconds: number;
  readonly #onEvent: ((event: PtyProcessGuardianEvent) => void) | undefined;
  readonly #onFailure: ((error: Error) => void) | undefined;
  readonly #pending = new Map<string, PendingRequest>();
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #closing = false;

  public constructor(options: PtyProcessGuardianOptions) {
    const leaseTimeoutMilliseconds = positiveInteger(
      options.leaseTimeoutMilliseconds,
      "leaseTimeoutMilliseconds",
    );
    this.#leaseTimeoutMilliseconds = leaseTimeoutMilliseconds;
    const terminationGraceMilliseconds = positiveInteger(
      options.terminationGraceMilliseconds ?? 500,
      "terminationGraceMilliseconds",
    );
    this.#onEvent = options.onEvent;
    this.#onFailure = options.onFailure;
    const childModule = guardianChildModule();
    const childArguments = childModule.endsWith(".ts")
      ? ["--import", "tsx", childModule]
      : [childModule];
    this.#child = spawn(process.execPath, childArguments, {
      env: {
        ...process.env,
        ITERM_GUARDIAN_LEASE_TIMEOUT_MS: leaseTimeoutMilliseconds.toString(),
        ITERM_GUARDIAN_TERMINATION_GRACE_MS: terminationGraceMilliseconds.toString(),
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.#child.on("message", (message: unknown) => this.#handleMessage(message));
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("exit", (code, signal) => {
      this.#closed = true;
      const error = new Error(
        `PTY Process Guardian exited (code=${code?.toString() ?? "null"}, signal=${signal ?? "null"})`,
      );
      for (const request of this.#pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.#pending.clear();
      if (!this.#closing) this.#fail(error);
    });
  }

  public get pid(): number | undefined {
    return this.#child.pid;
  }

  public register(shellPid: number): Promise<void> {
    return this.#request({ shellPid: positiveInteger(shellPid, "shellPid"), type: "register" });
  }

  public unregister(shellPid: number): void {
    if (this.#closed || this.#closing) return;
    this.#child.send?.({ shellPid: positiveInteger(shellPid, "shellPid"), type: "unregister" });
  }

  public renew(timeoutMilliseconds = this.#leaseTimeoutMilliseconds): Promise<void> {
    const timeout = positiveInteger(timeoutMilliseconds, "timeoutMilliseconds");
    if (timeout > this.#leaseTimeoutMilliseconds) {
      return Promise.reject(new Error("Process Guardian renewal exceeds its maximum timeout"));
    }
    return this.#request({ timeoutMilliseconds: timeout, type: "renew" });
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    const exited = new Promise<void>((resolve) => this.#child.once("exit", () => resolve()));
    this.#child.send?.({ type: "close" });
    const forced = setTimeout(() => this.#child.kill("SIGKILL"), REQUEST_TIMEOUT_MILLISECONDS);
    await exited;
    clearTimeout(forced);
  }

  #request(message: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.#closed || this.#closing || !this.#child.connected) {
      return Promise.reject(new Error("PTY Process Guardian is unavailable"));
    }
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("PTY Process Guardian request timed out"));
      }, REQUEST_TIMEOUT_MILLISECONDS);
      this.#pending.set(requestId, { reject, resolve, timer });
      this.#child.send?.({ ...message, requestId }, (error) => {
        if (error === null) return;
        const pending = this.#pending.get(requestId);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.#pending.delete(requestId);
        pending.reject(error);
      });
    });
  }

  #handleMessage(message: unknown): void {
    if (isGuardianAck(message)) {
      const request = this.#pending.get(message.requestId);
      if (request === undefined) return;
      clearTimeout(request.timer);
      this.#pending.delete(message.requestId);
      if (message.error === undefined) request.resolve();
      else request.reject(new Error(message.error));
      return;
    }
    if (!isGuardianEvent(message)) return;
    try {
      this.#onEvent?.({
        processCount: message.processCount,
        reason: message.reason,
        registeredSessions: message.registeredSessions,
        type: "reclaimed",
      });
    } catch {
      // Diagnostics must not change Guardian safety behavior.
    }
  }

  #fail(error: Error): void {
    try {
      this.#onFailure?.(error);
    } catch {
      // A failure reporter cannot restore a lost Guardian.
    }
  }
}

function guardianChildModule(): string {
  const javascript = new URL("./pty-process-guardian-child.js", import.meta.url);
  if (existsSync(fileURLToPath(javascript))) return fileURLToPath(javascript);
  return fileURLToPath(new URL("./pty-process-guardian-child.ts", import.meta.url));
}

function isGuardianAck(value: unknown): value is GuardianAck {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "ack" &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    (!("error" in value) || value.error === undefined || typeof value.error === "string")
  );
}

function isGuardianEvent(value: unknown): value is GuardianEventMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "event" &&
    "event" in value &&
    value.event === "reclaimed" &&
    "reason" in value &&
    (value.reason === "guardian_close" ||
      value.reason === "lease_timeout" ||
      value.reason === "parent_disconnect") &&
    "processCount" in value &&
    isNonNegativeInteger(value.processCount) &&
    "registeredSessions" in value &&
    isNonNegativeInteger(value.registeredSessions)
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
