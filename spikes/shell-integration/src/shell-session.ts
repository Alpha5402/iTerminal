import { spawnSync } from "node:child_process";
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import * as pty from "node-pty";
import type { IPty } from "node-pty";

import { ControlFrameDecoder, type ControlEvent } from "./control-protocol.js";
import { createShellLaunchProfile, type ShellKind } from "./shell-profile.js";

const MAX_CAPTURED_OUTPUT_CHARS = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export type SessionState = "starting" | "ready" | "reserved" | "running" | "broken" | "closed";

export interface ExecutionResult {
  readonly executionId: string;
  readonly command: string;
  readonly observedCommand?: string;
  readonly exitCode: number;
  readonly cwd: string;
  readonly output: string;
}

export interface ExecuteOptions {
  readonly timeoutMs?: number;
  readonly onRunning?: (executionId: string) => void;
}

export type DebugLogger = (message: string) => void;

interface PendingExecution {
  readonly id: string;
  readonly command: string;
  readonly outputStart: number;
  onRunning?: (executionId: string) => void;
  observedCommand?: string;
  resultExitCode?: number;
}

interface ControlWaiter {
  readonly afterIndex: number;
  readonly predicate: (event: ControlEvent) => boolean;
  readonly resolve: (event: ControlEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class ShellSpikeSession {
  readonly #runtimeDirectory: string;
  readonly #workspaceDirectory: string;
  readonly #controlFifo: string;
  readonly #controlFd: number;
  readonly #controlPoll: NodeJS.Timeout;
  readonly #decoder = new ControlFrameDecoder();
  readonly #debug: DebugLogger;
  readonly #pty: IPty;
  readonly #controlEvents: ControlEvent[] = [];
  readonly #waiters = new Set<ControlWaiter>();

  #capturedOutput = "";
  #state: SessionState = "starting";
  #pendingExecution: PendingExecution | undefined;
  #fatalError?: Error;

  private constructor(shell: ShellKind, debug: DebugLogger) {
    this.#debug = debug;
    this.#runtimeDirectory = mkdtempSync(join(tmpdir(), "iterminal-shell-spike-"));
    this.#workspaceDirectory = join(this.#runtimeDirectory, "workspace");
    this.#controlFifo = join(this.#runtimeDirectory, "control.fifo");
    mkdirSync(this.#workspaceDirectory, { mode: 0o700 });

    const mkfifo = spawnSync("mkfifo", [this.#controlFifo], { encoding: "utf8" });
    if (mkfifo.status !== 0) {
      throw new Error(`mkfifo failed: ${mkfifo.stderr || `status ${String(mkfifo.status)}`}`);
    }

    this.#controlFd = openSync(this.#controlFifo, constants.O_RDWR | constants.O_NONBLOCK);
    this.#controlPoll = setInterval(() => this.#pollControlChannel(), 2);

    const profile = createShellLaunchProfile(shell, this.#runtimeDirectory, this.#controlFifo);
    this.#debug(`spawning ${profile.executable} ${profile.args.join(" ")}`);
    this.#pty = pty.spawn(profile.executable, [...profile.args], {
      cols: 100,
      cwd: this.#workspaceDirectory,
      env: createChildEnvironment(profile.env),
      name: "xterm-256color",
      rows: 30,
    });
    this.#pty.onData((data) => {
      this.#capturedOutput += data;
      if (this.#capturedOutput.length > MAX_CAPTURED_OUTPUT_CHARS) {
        this.#capturedOutput = this.#capturedOutput.slice(-MAX_CAPTURED_OUTPUT_CHARS);
      }
    });
    this.#pty.onExit(({ exitCode, signal }) => {
      if (this.#state !== "closed") {
        this.#state = "broken";
        this.#fail(
          new Error(`Persistent shell exited unexpectedly (exit=${exitCode}, signal=${signal})`),
        );
      }
    });
  }

  public static async start(
    shell: ShellKind,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    debug: DebugLogger = () => undefined,
  ): Promise<ShellSpikeSession> {
    const session = new ShellSpikeSession(shell, debug);
    const startIndex = session.#controlEvents.length;
    await session.#waitFor((event) => event.type === "hello", startIndex, timeoutMs);
    await session.#waitFor((event) => event.type === "ready", startIndex, timeoutMs);
    if (session.#state !== "ready") {
      throw new Error(`Shell did not become ready; current state is ${session.#state}`);
    }
    return session;
  }

  public get state(): SessionState {
    return this.#state;
  }

  public get workspaceDirectory(): string {
    return this.#workspaceDirectory;
  }

  public get output(): string {
    return this.#capturedOutput;
  }

  public async execute(command: string, options: ExecuteOptions = {}): Promise<ExecutionResult> {
    if (this.#fatalError !== undefined) {
      throw this.#fatalError;
    }
    if (this.#state !== "ready" || this.#pendingExecution !== undefined) {
      throw new Error(`PTY_BUSY: shell state is ${this.#state}`);
    }
    if (command.includes("\0")) {
      throw new Error("ExecuteAction cannot contain NUL bytes");
    }

    const executionId = randomUUID();
    const startIndex = this.#controlEvents.length;
    const pending: PendingExecution = {
      command,
      id: executionId,
      outputStart: this.#capturedOutput.length,
      ...(options.onRunning === undefined ? {} : { onRunning: options.onRunning }),
    };
    this.#pendingExecution = pending;
    this.#state = "reserved";
    this.#debug(`dispatching ${executionId}: ${JSON.stringify(command)}`);
    const ptyBarrier = `\x1b]1337;iTerminalBarrier=${executionId}\x07`;
    this.#pty.write(`${wrapForTopLevelEval(command, executionId)}\r`);

    try {
      const event = await this.#waitFor(
        (candidate) => candidate.type === "ready",
        startIndex,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      if (event.type !== "ready") {
        throw new Error("Expected READY control event");
      }
      if (pending.resultExitCode !== undefined) {
        await this.#waitForPtyText(ptyBarrier, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      }
      return {
        command,
        cwd: event.cwd,
        executionId,
        exitCode: pending.resultExitCode ?? event.exitCode,
        output: this.#capturedOutput.slice(pending.outputStart),
        ...(pending.observedCommand === undefined
          ? {}
          : { observedCommand: pending.observedCommand }),
      };
    } finally {
      this.#finishExecution(executionId);
    }
  }

  public sendTtyControl(control: "CTRL_C" | "CTRL_D" | "CTRL_Z" | "ESC"): void {
    const bytes: Readonly<Record<typeof control, string>> = {
      CTRL_C: "\x03",
      CTRL_D: "\x04",
      CTRL_Z: "\x1a",
      ESC: "\x1b",
    };
    this.#pty.write(bytes[control]);
  }

  public close(): void {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closed";
    this.#debug("closing shell session");
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Shell session closed"));
    }
    this.#waiters.clear();
    this.#pty.kill();
    clearInterval(this.#controlPoll);
    closeSync(this.#controlFd);
    rmSync(this.#runtimeDirectory, { force: true, recursive: true });
  }

  #handleControlEvent(event: ControlEvent): void {
    this.#debug(`control ${JSON.stringify(event)}`);
    this.#controlEvents.push(event);

    if (event.type === "ready" && this.#state === "starting") {
      this.#state = "ready";
    } else if (event.type === "preexec" && this.#pendingExecution !== undefined) {
      if (this.#pendingExecution.observedCommand === undefined) {
        this.#pendingExecution.observedCommand = event.command;
        this.#state = "running";
        this.#pendingExecution.onRunning?.(this.#pendingExecution.id);
      }
    } else if (event.type === "result" && this.#pendingExecution !== undefined) {
      this.#pendingExecution.resultExitCode = event.exitCode;
    }

    const eventIndex = this.#controlEvents.length - 1;
    for (const waiter of this.#waiters) {
      if (eventIndex >= waiter.afterIndex && waiter.predicate(event)) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  }

  #pollControlChannel(): void {
    const buffer = Buffer.allocUnsafe(16 * 1024);
    try {
      for (;;) {
        const bytesRead = readSync(this.#controlFd, buffer, 0, buffer.length, null);
        if (bytesRead === 0) {
          return;
        }
        for (const event of this.#decoder.push(buffer.subarray(0, bytesRead))) {
          this.#handleControlEvent(event);
        }
        if (bytesRead < buffer.length) {
          return;
        }
      }
    } catch (error) {
      if (isWouldBlockError(error)) {
        return;
      }
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #finishExecution(executionId: string): void {
    if (this.#pendingExecution?.id !== executionId) {
      return;
    }
    this.#pendingExecution = undefined;
    if (this.#state !== "broken" && this.#state !== "closed") {
      this.#state = "ready";
    }
  }

  #waitFor(
    predicate: (event: ControlEvent) => boolean,
    afterIndex: number,
    timeoutMs: number,
  ): Promise<ControlEvent> {
    if (this.#fatalError !== undefined) {
      return Promise.reject(this.#fatalError);
    }

    for (let index = afterIndex; index < this.#controlEvents.length; index += 1) {
      const event = this.#controlEvents[index];
      if (event !== undefined && predicate(event)) {
        return Promise.resolve(event);
      }
    }

    return new Promise<ControlEvent>((resolve, reject) => {
      const waiter: ControlWaiter = {
        afterIndex,
        predicate,
        reject,
        resolve,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(
            new Error(`Timed out after ${String(timeoutMs)} ms waiting for Shell control event`),
          );
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  #waitForPtyText(expected: string, timeoutMs: number): Promise<void> {
    if (this.#capturedOutput.includes(expected)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const poll = setInterval(() => {
        if (this.#capturedOutput.includes(expected)) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(poll);
          reject(new Error("Timed out waiting for PTY output barrier"));
        }
      }, 2);
    });
  }

  #fail(error: Error): void {
    this.#fatalError ??= error;
    if (this.#state !== "closed") {
      this.#state = "broken";
    }
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }
}

function createChildEnvironment(extra: Readonly<Record<string, string>>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return {
    ...environment,
    ...extra,
    TERM: "xterm-256color",
  };
}

function wrapForTopLevelEval(command: string, barrierToken: string): string {
  return `__it_execute ${quoteForShell(command)} ${quoteForShell(barrierToken)}`;
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isWouldBlockError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "EAGAIN" || error.code === "EWOULDBLOCK";
}
