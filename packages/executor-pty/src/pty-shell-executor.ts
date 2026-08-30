import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CreateExecutorOptions,
  ShellExecuteCallbacks,
  ShellExecutionResult,
  ShellExecutor,
  ShellExecutorFactory,
} from "@iterminal/application";
import {
  CANONICAL_TERMINAL_COLUMNS,
  CANONICAL_TERMINAL_ROWS,
  MAX_TERMINAL_COLUMNS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLUMNS,
  MIN_TERMINAL_ROWS,
  type ControlDelivery,
  type ShellKind,
} from "@iterminal/domain";
import * as pty from "node-pty";
import type { IPty } from "node-pty";

import { BoundedByteRing } from "./bounded-byte-ring.js";
import { ControlFrameDecoder, type ControlEvent } from "./control-protocol.js";
import { createShellLaunchProfile } from "./shell-profile.js";

const START_TIMEOUT_MS = 5_000;
const EXECUTE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const SESSION_RING_BYTES = 8 * 1024 * 1024;
const EXECUTION_RING_BYTES = 2 * 1024 * 1024;
const PTY_BARRIER_PREFIX = "\x1b]1337;iTerminalBarrier=";
const PTY_BARRIER_SUFFIX = "\x07";

interface PendingExecution {
  readonly token: string;
  readonly capture: BoundedByteRing;
  readonly callbacks: ShellExecuteCallbacks;
  readonly resolve: (result: ShellExecutionResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  resultExitCode?: number;
  readyEvent?: Readonly<{ exitCode: number; cwd: string }>;
  barrierSeen: boolean;
  started: boolean;
}

interface ControlWaiter {
  readonly afterIndex: number;
  readonly predicate: (event: ControlEvent) => boolean;
  readonly resolve: (event: ControlEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class PtyShellExecutorFactory implements ShellExecutorFactory {
  public async create(options: CreateExecutorOptions): Promise<ShellExecutor> {
    return PtyShellExecutor.start(options);
  }
}

export class PtyShellExecutor implements ShellExecutor {
  readonly #runtimeDirectory: string;
  readonly #controlFifo: string;
  readonly #controlFd: number;
  readonly #controlPoll: NodeJS.Timeout;
  readonly #decoder = new ControlFrameDecoder();
  readonly #events: ControlEvent[] = [];
  readonly #waiters = new Set<ControlWaiter>();
  readonly #pty: IPty;
  readonly #sessionOutput = new BoundedByteRing(SESSION_RING_BYTES);
  readonly #onOutput: (data: string) => void;

  #pending: PendingExecution | undefined;
  #pendingPtyText = "";
  #closed = false;
  #fatalError?: Error;

  public readonly shell: ShellKind;
  public readonly shellPid: number;

  private constructor(options: CreateExecutorOptions) {
    this.shell = options.shell;
    this.#onOutput = options.onOutput;
    this.#runtimeDirectory = mkdtempSync(join(tmpdir(), "iterminal-runtime-"));
    this.#controlFifo = join(this.#runtimeDirectory, "control.fifo");
    let controlFd: number | undefined;
    let controlPoll: NodeJS.Timeout | undefined;
    let shellPty: IPty | undefined;
    try {
      const workspaceRoot = realpathSync(options.workspaceRoot);
      const fifo = spawnSync("mkfifo", [this.#controlFifo], { encoding: "utf8" });
      if (fifo.status !== 0) {
        throw new Error(`mkfifo failed: ${fifo.stderr || String(fifo.status)}`);
      }
      chmodSync(this.#controlFifo, 0o600);
      controlFd = openSync(this.#controlFifo, constants.O_RDWR | constants.O_NONBLOCK);
      const profile = createShellLaunchProfile(
        options.shell,
        this.#runtimeDirectory,
        this.#controlFifo,
      );
      shellPty = pty.spawn(profile.executable, [...profile.args], {
        cols: CANONICAL_TERMINAL_COLUMNS,
        cwd: workspaceRoot,
        env: childEnvironment(profile.env),
        name: "xterm-256color",
        rows: CANONICAL_TERMINAL_ROWS,
      });
      this.#pty = shellPty;
      this.shellPid = shellPty.pid;
      this.#controlFd = controlFd;
      controlPoll = setInterval(() => this.#pollControl(), 2);
      this.#controlPoll = controlPoll;
    } catch (error) {
      shellPty?.kill();
      if (controlPoll !== undefined) {
        clearInterval(controlPoll);
      }
      if (controlFd !== undefined) {
        closeSync(controlFd);
      }
      rmSync(this.#runtimeDirectory, { force: true, recursive: true });
      throw error;
    }
    this.#pty.onData((data) => {
      this.#handlePtyData(data);
    });
    this.#pty.onExit(({ exitCode, signal }) => {
      if (!this.#closed) {
        this.#fail(
          new Error(`Persistent Shell exited unexpectedly (exit=${exitCode}, signal=${signal})`),
        );
      }
    });
  }

  public static async start(options: CreateExecutorOptions): Promise<PtyShellExecutor> {
    const executor = new PtyShellExecutor(options);
    try {
      const startIndex = executor.#events.length;
      await executor.#waitFor((event) => event.type === "hello", startIndex, START_TIMEOUT_MS);
      await executor.#waitFor((event) => event.type === "ready", startIndex, START_TIMEOUT_MS);
      return executor;
    } catch (error) {
      executor.close();
      throw error;
    }
  }

  public execute(command: string, callbacks: ShellExecuteCallbacks): Promise<ShellExecutionResult> {
    if (this.#fatalError !== undefined) {
      return Promise.reject(this.#fatalError);
    }
    if (this.#closed) {
      return Promise.reject(new Error("Executor is closed"));
    }
    if (this.#pending !== undefined) {
      return Promise.reject(new Error("Executor already has a pending execution"));
    }
    if (command.includes("\0")) {
      return Promise.reject(new Error("Command cannot contain NUL bytes"));
    }

    const token = randomUUID();
    return new Promise<ShellExecutionResult>((resolve, reject) => {
      const pending: PendingExecution = {
        callbacks,
        barrierSeen: false,
        capture: new BoundedByteRing(EXECUTION_RING_BYTES),
        reject,
        resolve,
        started: false,
        timer: setTimeout(() => {
          if (this.#pending?.token === token) {
            this.#pending = undefined;
            reject(new Error("Execution exceeded the 24-hour adapter safety timeout"));
          }
        }, EXECUTE_TIMEOUT_MS),
        token,
      };
      this.#pending = pending;
      this.#pty.write(`${wrapCommand(command, token)}\r`);
    });
  }

  public writeInput(data: string): void {
    this.#assertInteractive();
    this.#pty.write(data);
  }

  public sendControl(delivery: ControlDelivery): void {
    this.#assertInteractive();
    if (delivery.mode === "TTY_CONTROL") {
      const bytes = {
        CTRL_C: "\x03",
        CTRL_D: "\x04",
        CTRL_Z: "\x1a",
        ESC: "\x1b",
      } as const;
      this.#pty.write(bytes[delivery.control]);
      return;
    }
    const processGroup = foregroundProcessGroup(this.shellPid);
    process.kill(-processGroup, delivery.signal);
  }

  public resize(columns: number, rows: number): void {
    if (this.#closed || this.#fatalError !== undefined) {
      throw this.#fatalError ?? new Error("Executor is closed");
    }
    if (
      !Number.isSafeInteger(columns) ||
      columns < MIN_TERMINAL_COLUMNS ||
      columns > MAX_TERMINAL_COLUMNS ||
      !Number.isSafeInteger(rows) ||
      rows < MIN_TERMINAL_ROWS ||
      rows > MAX_TERMINAL_ROWS
    ) {
      throw new Error("Terminal geometry is outside the controlled bounds");
    }
    this.#pty.resize(columns, rows);
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const error = new Error("Executor closed");
    this.#pending?.reject(error);
    if (this.#pending !== undefined) {
      clearTimeout(this.#pending.timer);
      this.#pending = undefined;
    }
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
    clearInterval(this.#controlPoll);
    this.#pty.kill();
    closeSync(this.#controlFd);
    rmSync(this.#runtimeDirectory, { force: true, recursive: true });
  }

  #assertInteractive(): void {
    if (this.#closed || this.#pending === undefined || !this.#pending.started) {
      throw new Error("No running foreground execution");
    }
  }

  #handleControl(event: ControlEvent): void {
    this.#events.push(event);
    const pending = this.#pending;
    if (event.type === "preexec" && pending !== undefined && !pending.started) {
      pending.started = true;
      pending.callbacks.onStarted(event.command);
    } else if (event.type === "result" && pending !== undefined) {
      pending.resultExitCode = event.exitCode;
    } else if (event.type === "ready" && pending !== undefined && pending.started) {
      pending.readyEvent = { cwd: event.cwd, exitCode: event.exitCode };
      this.#tryFinishPending(pending);
    }
    const eventIndex = this.#events.length - 1;
    for (const waiter of this.#waiters) {
      if (eventIndex >= waiter.afterIndex && waiter.predicate(event)) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  }

  #pollControl(): void {
    const buffer = Buffer.allocUnsafe(16 * 1024);
    try {
      for (;;) {
        const bytesRead = readSync(this.#controlFd, buffer, 0, buffer.length, null);
        if (bytesRead === 0) {
          return;
        }
        for (const event of this.#decoder.push(buffer.subarray(0, bytesRead))) {
          this.#handleControl(event);
        }
        if (bytesRead < buffer.length) {
          return;
        }
      }
    } catch (error) {
      if (!wouldBlock(error)) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #handlePtyData(data: string): void {
    this.#pendingPtyText += data;
    for (;;) {
      const markerStart = this.#pendingPtyText.indexOf(PTY_BARRIER_PREFIX);
      if (markerStart < 0) {
        const retained = partialPrefixLength(this.#pendingPtyText, PTY_BARRIER_PREFIX);
        const visibleLength = this.#pendingPtyText.length - retained;
        this.#emitPty(this.#pendingPtyText.slice(0, visibleLength));
        this.#pendingPtyText = this.#pendingPtyText.slice(visibleLength);
        return;
      }
      this.#emitPty(this.#pendingPtyText.slice(0, markerStart));
      const tokenStart = markerStart + PTY_BARRIER_PREFIX.length;
      const markerEnd = this.#pendingPtyText.indexOf(PTY_BARRIER_SUFFIX, tokenStart);
      if (markerEnd < 0) {
        this.#pendingPtyText = this.#pendingPtyText.slice(markerStart);
        return;
      }
      const token = this.#pendingPtyText.slice(tokenStart, markerEnd);
      const rawMarker = this.#pendingPtyText.slice(markerStart, markerEnd + 1);
      this.#pendingPtyText = this.#pendingPtyText.slice(markerEnd + 1);
      const pending = this.#pending;
      if (pending?.token === token) {
        pending.barrierSeen = true;
        this.#tryFinishPending(pending);
      } else {
        this.#emitPty(rawMarker);
      }
    }
  }

  #emitPty(data: string): void {
    if (data.length === 0) {
      return;
    }
    this.#sessionOutput.append(data);
    this.#pending?.capture.append(data);
    try {
      this.#onOutput(data);
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #tryFinishPending(pending: PendingExecution): void {
    if (pending.readyEvent === undefined) {
      return;
    }
    if (pending.resultExitCode !== undefined && !pending.barrierSeen) {
      return;
    }
    clearTimeout(pending.timer);
    if (this.#pending?.token === pending.token) {
      this.#pending = undefined;
    }
    const output = pending.capture.snapshot();
    pending.resolve({
      cwd: pending.readyEvent.cwd,
      exitCode: pending.resultExitCode ?? pending.readyEvent.exitCode,
      output: output.data,
      outputTruncated: output.truncated,
    });
  }

  #waitFor(
    predicate: (event: ControlEvent) => boolean,
    afterIndex: number,
    timeoutMs: number,
  ): Promise<ControlEvent> {
    for (let index = afterIndex; index < this.#events.length; index += 1) {
      const event = this.#events[index];
      if (event !== undefined && predicate(event)) {
        return Promise.resolve(event);
      }
    }
    return new Promise((resolve, reject) => {
      const waiter: ControlWaiter = {
        afterIndex,
        predicate,
        reject,
        resolve,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error(`Timed out after ${timeoutMs.toString()} ms waiting for Shell event`));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  #fail(error: Error): void {
    this.#fatalError ??= error;
    if (this.#pending !== undefined) {
      clearTimeout(this.#pending.timer);
      this.#pending.reject(error);
      this.#pending = undefined;
    }
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
    queueMicrotask(() => this.close());
  }
}

function wrapCommand(command: string, barrierToken: string): string {
  return `__it_execute ${quote(command)} ${quote(barrierToken)}`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function childEnvironment(extra: Readonly<Record<string, string>>): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    TERM: "xterm-256color",
  };
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"] as const) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return { ...environment, ...extra };
}

function foregroundProcessGroup(shellPid: number): number {
  const result = spawnSync("/bin/ps", ["-o", "tpgid=", "-p", shellPid.toString()], {
    encoding: "utf8",
  });
  const processGroup = Number.parseInt(result.stdout.trim(), 10);
  if (result.status !== 0 || !Number.isSafeInteger(processGroup) || processGroup <= 0) {
    throw new Error(`Unable to resolve foreground process group for Shell ${shellPid.toString()}`);
  }
  return processGroup;
}

function wouldBlock(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
  );
}

function partialPrefixLength(value: string, prefix: string): number {
  const maximum = Math.min(value.length, prefix.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (value.endsWith(prefix.slice(0, length))) {
      return length;
    }
  }
  return 0;
}
