import { tmpdir } from "node:os";

import {
  RuntimeService,
  type CreateExecutorOptions,
  type ExecutionOutputReadRequest,
  type ExecutionWaitScheduler,
  type RuntimeDurability,
  type ShellExecutor,
  type ShellExecutorFactory,
} from "@iterminal/application";
import type { Execution, Session } from "@iterminal/domain";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import { agentActor } from "@iterminal/testkit";
import { describe, expect, it, vi } from "vitest";

describe("Application compact Execution observation", () => {
  it("uses one wait budget then returns one lossless durable page with visible controls", async () => {
    const scheduler = new VirtualWaitScheduler();
    const bytes = Buffer.from("\u001b[31mfixture command\r\nfixture command\u001b[0m\r\n", "utf8");
    const read = vi.fn((request: ExecutionOutputReadRequest) =>
      Promise.resolve({
        chunks: [{ byteLength: bytes.length, contentBase64: bytes.toString("base64") }],
        encoding: "base64" as const,
        executionId: request.executionId,
        executionState: "RUNNING" as const,
        gap: null,
        generation: request.generation,
        hasMore: false,
        nextCursor: "opaque-next",
        persistenceLag: "possible" as const,
        retention: { minimumAvailableSequence: 1, source: "durable" as const },
        sessionId: request.sessionId,
        stream: "pty" as const,
      }),
    );
    const { execution, runtime } = runtimeWithExecution("RUNNING", scheduler, read);
    const observing = runtime.observeExecution({
      executionId: execution.id,
      generation: execution.sessionGeneration,
      sessionId: execution.sessionId,
      waitMs: 100,
    });

    expect(scheduler.createdCount).toBe(1);
    expect(read).not.toHaveBeenCalled();
    scheduler.advance(100);
    const result = await observing;
    expect(read).toHaveBeenCalledTimes(1);
    expect(Buffer.from(result.output.contentBase64, "base64")).toEqual(bytes);
    expect(result).toMatchObject({
      gap: null,
      identity: {
        executionId: execution.id,
        generation: execution.sessionGeneration,
        sessionId: execution.sessionId,
      },
      nextActions: ["wait_for_completion"],
      nextCursor: "opaque-next",
      output: {
        hasMore: false,
        stream: "pty",
        text: "␛[31mfixture command\r\nfixture command␛[0m\r\n",
        textStatus: "complete",
      },
      state: { completed: false, executionState: "RUNNING", persistenceLag: "possible" },
    });
  });

  it("checks exact scope before cursor handling, waiting, or output reading", async () => {
    const scheduler = new VirtualWaitScheduler();
    const read = vi.fn();
    const { execution, runtime } = runtimeWithExecution("RUNNING", scheduler, read);

    await expect(
      runtime.observeExecution({
        cursor: "not even a canonical cursor!",
        executionId: execution.id,
        generation: execution.sessionGeneration,
        sessionId: "another-session",
        waitMs: 30_000,
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
    expect(scheduler.createdCount).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it("cancels the sole waiter without reading output or writing control", async () => {
    const scheduler = new VirtualWaitScheduler();
    const read = vi.fn();
    const { execution, executor, runtime } = runtimeWithExecution("RUNNING", scheduler, read);
    const controller = new AbortController();
    const observing = runtime.observeExecution(
      {
        executionId: execution.id,
        generation: execution.sessionGeneration,
        sessionId: execution.sessionId,
        waitMs: 30_000,
      },
      controller.signal,
    );

    controller.abort();
    await expect(observing).rejects.toMatchObject({ name: "AbortError" });
    expect(scheduler.pendingCount).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(executor.controlWrites).toBe(0);
  });

  it("fails explicitly if a post-wait read would regress a terminal state", async () => {
    const scheduler = new VirtualWaitScheduler();
    const read = vi.fn((request: ExecutionOutputReadRequest) =>
      Promise.resolve(emptyOutput(request, "RUNNING", "possible")),
    );
    const { execution, runtime } = runtimeWithExecution("COMPLETED", scheduler, read);

    await expect(
      runtime.observeExecution({
        executionId: execution.id,
        generation: execution.sessionGeneration,
        sessionId: execution.sessionId,
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      message: "Execution observation state moved backward after terminal settlement",
    });
    expect(scheduler.createdCount).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reports an unaligned UTF-8 page and points UNKNOWN only at original-request lookup", async () => {
    const scheduler = new VirtualWaitScheduler();
    const bytes = Buffer.from([0xf0, 0x9f]);
    const read = vi.fn((request: ExecutionOutputReadRequest) =>
      Promise.resolve({
        ...emptyOutput(request, "UNKNOWN", "none"),
        chunks: [{ byteLength: bytes.length, contentBase64: bytes.toString("base64") }],
        nextCursor: "unknown-next",
      }),
    );
    const { execution, runtime } = runtimeWithExecution("UNKNOWN", scheduler, read);

    const observed = await runtime.observeExecution({
      executionId: execution.id,
      generation: execution.sessionGeneration,
      sessionId: execution.sessionId,
      waitMs: 0,
    });
    expect(observed.output).toMatchObject({ textStatus: "unaligned_utf8" });
    expect(observed.output).not.toHaveProperty("text");
    expect(observed.nextActions).toEqual(["lookup_original_action"]);
    expect(JSON.stringify(observed)).not.toContain("idempotency");
    expect(JSON.stringify(observed)).not.toContain("fixture command");
  });
});

function runtimeWithExecution(
  status: Execution["status"],
  scheduler: ExecutionWaitScheduler,
  readExecutionOutput: RuntimeDurability["readExecutionOutput"],
): Readonly<{
  execution: Execution;
  executor: ReadOnlyExecutor;
  runtime: RuntimeService;
}> {
  const store = new MemoryRuntimeStore();
  const session: Session = {
    actionSequence: 1,
    createdAt: new Date(0).toISOString(),
    eventSequence: 1,
    generation: 3,
    id: "session-observe",
    ownerId: "local",
    screenVersion: 0,
    shell: "zsh",
    status: status === "DISPATCHING" ? "RESERVED" : status === "RUNNING" ? "RUNNING" : "READY",
    workspaceRoot: tmpdir(),
  };
  const execution: Execution = {
    actionId: "action-observe",
    actor: agentActor,
    command: "fixture command",
    createdAt: new Date(0).toISOString(),
    id: "execution-observe",
    sessionGeneration: session.generation,
    sessionId: session.id,
    status,
    version: 1,
  };
  store.createSession(session);
  store.saveExecution(execution);
  const executor = new ReadOnlyExecutor();
  const runtime = new RuntimeService(store, new ReadOnlyExecutorFactory(executor), {
    durability: { readExecutionOutput } as unknown as RuntimeDurability,
    executionWaitScheduler: scheduler,
  });
  return { execution, executor, runtime };
}

function emptyOutput(
  request: ExecutionOutputReadRequest,
  executionState: Execution["status"],
  persistenceLag: "none" | "possible",
) {
  return {
    chunks: [],
    encoding: "base64" as const,
    executionId: request.executionId,
    executionState,
    gap: null,
    generation: request.generation,
    hasMore: false,
    persistenceLag,
    retention: { minimumAvailableSequence: 1, source: "durable" as const },
    sessionId: request.sessionId,
    stream: "pty" as const,
  };
}

class VirtualWaitScheduler implements ExecutionWaitScheduler {
  public createdCount = 0;
  #now = 0;
  #nextId = 1;
  readonly #tasks = new Map<number, { callback: () => void; dueAt: number }>();

  public get pendingCount(): number {
    return this.#tasks.size;
  }

  public clearTimeout(handle: unknown): void {
    this.#tasks.delete(handle as number);
  }

  public setTimeout(callback: () => void, milliseconds: number): unknown {
    const id = this.#nextId;
    this.#nextId += 1;
    this.createdCount += 1;
    this.#tasks.set(id, { callback, dueAt: this.#now + milliseconds });
    return id;
  }

  public advance(milliseconds: number): void {
    this.#now += milliseconds;
    for (const [id, task] of [...this.#tasks]) {
      if (task.dueAt > this.#now) continue;
      this.#tasks.delete(id);
      task.callback();
    }
  }
}

class ReadOnlyExecutorFactory implements ShellExecutorFactory {
  public constructor(private readonly executor: ReadOnlyExecutor) {}

  public create(options: CreateExecutorOptions): Promise<ShellExecutor> {
    this.executor.options = options;
    return Promise.resolve(this.executor);
  }
}

class ReadOnlyExecutor implements ShellExecutor {
  public readonly shell = "zsh" as const;
  public readonly shellPid = process.pid;
  public controlWrites = 0;
  public options: CreateExecutorOptions | undefined;

  public checkpoint() {
    return { cwd: this.options?.workspaceRoot ?? tmpdir(), filteredEnvironment: {} };
  }

  public execute(): never {
    throw new Error("Compact observation must not execute");
  }

  public writeInput(): never {
    throw new Error("Compact observation must not write input");
  }

  public writeSecret(): never {
    throw new Error("Compact observation must not write a secret");
  }

  public finishSensitiveOutput(): void {}

  public sendControl(): void {
    this.controlWrites += 1;
  }

  public resize(): never {
    throw new Error("Compact observation must not resize");
  }

  public close(): void {}
}
