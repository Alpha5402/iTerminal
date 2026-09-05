import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RuntimeService,
  type CreateExecutorOptions,
  type ExecutionWaitScheduler,
  type ShellExecutionResult,
  type ShellExecutor,
  type ShellExecutorFactory,
} from "@iterminal/application";
import type { ControlDelivery, ShellKind } from "@iterminal/domain";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import { agentActor } from "@iterminal/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

describe("bounded cancellable Execution wait", () => {
  it("returns waitMs=0 immediately without allocating a timer or Abort listener", async () => {
    const scheduler = new VirtualWaitScheduler();
    const { execution, runtime } = await startPendingExecution(scheduler);
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");

    await expect(
      runtime.waitExecutionV2({ executionId: execution.id, waitMs: 0 }, controller.signal),
    ).resolves.toEqual({
      completed: false,
      executionId: execution.id,
      executionState: "RUNNING",
    });
    expect(scheduler.createdCount).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
    expect(addListener).not.toHaveBeenCalled();
    expect(removeListener).not.toHaveBeenCalled();

    controller.abort();
    await runtime.closeSession(execution.sessionId, execution.sessionGeneration);
  });

  it("uses one injected 10-second timer and returns the current RUNNING snapshot", async () => {
    const scheduler = new VirtualWaitScheduler();
    const { execution, executor, runtime } = await startPendingExecution(scheduler);
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let settled = false;
    const waiting = runtime
      .waitExecutionV2({ executionId: execution.id }, controller.signal)
      .then((result) => {
        settled = true;
        return result;
      });

    expect(scheduler.createdCount).toBe(1);
    expect(scheduler.pendingCount).toBe(1);
    scheduler.advance(9_999);
    await Promise.resolve();
    expect(settled).toBe(false);
    executor.emitOutput("still producing output\n");
    scheduler.advance(1);
    await expect(waiting).resolves.toEqual({
      completed: false,
      executionId: execution.id,
      executionState: "RUNNING",
    });
    expect(scheduler.pendingCount).toBe(0);
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(executor.controlWrites).toHaveLength(0);
    expect(runtime.getExecution(execution.id).status).toBe("RUNNING");

    await runtime.closeSession(execution.sessionId, execution.sessionGeneration);
  });

  it("cancels one waiter independently while another receives real completion", async () => {
    const scheduler = new VirtualWaitScheduler();
    const { execution, executor, runtime } = await startPendingExecution(scheduler);
    const controller = new AbortController();
    const survivingController = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const cancelled = runtime.waitExecutionV2(
      { executionId: execution.id, waitMs: 30_000 },
      controller.signal,
    );
    const survivingRemoveListener = vi.spyOn(survivingController.signal, "removeEventListener");
    const surviving = runtime.waitExecutionV2(
      { executionId: execution.id, waitMs: 30_000 },
      survivingController.signal,
    );

    expect(scheduler.pendingCount).toBe(2);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(scheduler.pendingCount).toBe(1);
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(executor.controlWrites).toHaveLength(0);

    executor.complete(0);
    await expect(surviving).resolves.toEqual({
      completed: true,
      executionId: execution.id,
      executionState: "COMPLETED",
    });
    expect(scheduler.pendingCount).toBe(0);
    expect(survivingRemoveListener).toHaveBeenCalledTimes(1);
    await runtime.closeSession(execution.sessionId, execution.sessionGeneration);
  });

  it("treats completion rejection as a terminal snapshot notification", async () => {
    const scheduler = new VirtualWaitScheduler();
    const { execution, executor, runtime } = await startPendingExecution(scheduler);
    const waiting = runtime.waitExecutionV2({ executionId: execution.id, waitMs: 30_000 });

    executor.failAfterAcceptedWrite();
    await expect(waiting).resolves.toEqual({
      completed: true,
      executionId: execution.id,
      executionState: "UNKNOWN",
    });
    expect(scheduler.pendingCount).toBe(0);
    await runtime.closeSession(execution.sessionId, execution.sessionGeneration);
  });

  it("rejects an already-aborted signal without a timer or listener", async () => {
    const scheduler = new VirtualWaitScheduler();
    const { execution, runtime } = await startPendingExecution(scheduler);
    const controller = new AbortController();
    controller.abort();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");

    await expect(
      runtime.waitExecutionV2({ executionId: execution.id }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(scheduler.createdCount).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
    expect(addListener).not.toHaveBeenCalled();
    expect(removeListener).not.toHaveBeenCalled();
    await runtime.closeSession(execution.sessionId, execution.sessionGeneration);
  });

  it("cleans its Abort listener when scheduler allocation fails synchronously", async () => {
    const scheduler: ExecutionWaitScheduler = {
      clearTimeout: vi.fn(),
      setTimeout: () => {
        throw new Error("fixture scheduler unavailable");
      },
    };
    const { execution, executor, runtime } = await startPendingExecution(scheduler);
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");

    await expect(
      runtime.waitExecutionV2({ executionId: execution.id }, controller.signal),
    ).rejects.toThrow("fixture scheduler unavailable");
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);

    // A failed waiter registration does not consume or corrupt the shared completion.
    executor.complete(0);
    await expect(runtime.waitExecution(execution.id)).resolves.toMatchObject({
      status: "COMPLETED",
    });
    await runtime.closeSession(execution.sessionId, execution.sessionGeneration);
  });

  it("preserves exact unknown-Execution errors instead of returning incomplete", async () => {
    const scheduler = new VirtualWaitScheduler();
    const runtime = createRuntime(new PendingExecutorFactory(), scheduler);
    await expect(
      runtime.waitExecutionV2({ executionId: "execution-missing", waitMs: 0 }),
    ).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
    expect(scheduler.createdCount).toBe(0);
  });
});

async function startPendingExecution(scheduler: ExecutionWaitScheduler): Promise<{
  execution: ReturnType<RuntimeService["getExecution"]>;
  executor: PendingExecutor;
  runtime: RuntimeService;
}> {
  const factory = new PendingExecutorFactory();
  const runtime = createRuntime(factory, scheduler);
  const fixtureRoot = mkdtempSync(join(tmpdir(), "iterminal-execution-wait-"));
  fixtureRoots.push(fixtureRoot);
  const workspaceRoot = join(fixtureRoot, "workspace");
  mkdirSync(workspaceRoot);
  const session = await runtime.createSession({ shell: "zsh", workspaceRoot });
  const started = await runtime.startExecute({
    actor: agentActor,
    command: "fixture pending command",
    idempotencyKey: `wait-${fixtureRoots.length.toString()}`,
    sessionGeneration: session.generation,
    sessionId: session.id,
  });
  await started.started;
  return {
    execution: runtime.getExecution(started.execution.id),
    executor: factory.latest(),
    runtime,
  };
}

function createRuntime(
  factory: ShellExecutorFactory,
  scheduler: ExecutionWaitScheduler,
): RuntimeService {
  return new RuntimeService(new MemoryRuntimeStore(), factory, {
    executionWaitScheduler: scheduler,
  });
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
    for (;;) {
      const next = [...this.#tasks.entries()]
        .filter(([, task]) => task.dueAt <= this.#now)
        .sort(
          ([leftId, left], [rightId, right]) => left.dueAt - right.dueAt || leftId - rightId,
        )[0];
      if (next === undefined) return;
      this.#tasks.delete(next[0]);
      next[1].callback();
    }
  }
}

class PendingExecutorFactory implements ShellExecutorFactory {
  #executor: PendingExecutor | undefined;

  public create(options: CreateExecutorOptions): Promise<ShellExecutor> {
    this.#executor = new PendingExecutor(options);
    return Promise.resolve(this.#executor);
  }

  public latest(): PendingExecutor {
    if (this.#executor === undefined) throw new Error("No pending Executor was created");
    return this.#executor;
  }
}

class PendingExecutor implements ShellExecutor {
  public readonly shellPid = 707_203;
  public readonly shell: ShellKind;
  public readonly controlWrites: ControlDelivery[] = [];
  readonly #options: CreateExecutorOptions;
  #rejectExecution: ((error: Error) => void) | undefined;
  #resolveExecution: ((result: ShellExecutionResult) => void) | undefined;

  public constructor(options: CreateExecutorOptions) {
    this.#options = options;
    this.shell = options.shell;
  }

  public checkpoint(): Readonly<{
    cwd: string;
    filteredEnvironment: Readonly<Record<string, string>>;
  }> {
    return { cwd: this.#options.workspaceRoot, filteredEnvironment: {} };
  }

  public execute(
    command: string,
    callbacks: Readonly<{
      onStarted: (observedCommand: string) => void;
      onWriteAccepted?: () => void;
    }>,
  ): Promise<ShellExecutionResult> {
    callbacks.onWriteAccepted?.();
    callbacks.onStarted(command);
    return new Promise((resolve, reject) => {
      this.#resolveExecution = resolve;
      this.#rejectExecution = reject;
    });
  }

  public complete(exitCode: number): void {
    const resolve = this.#resolveExecution;
    if (resolve === undefined) throw new Error("No pending Execution to complete");
    this.#resolveExecution = undefined;
    this.#rejectExecution = undefined;
    resolve({
      cwd: this.#options.workspaceRoot,
      exitCode,
      filteredEnvironment: {},
      output: "fixture completed\n",
      outputTruncated: false,
    });
  }

  public failAfterAcceptedWrite(): void {
    const reject = this.#rejectExecution;
    if (reject === undefined) throw new Error("No pending Execution to fail");
    this.#resolveExecution = undefined;
    this.#rejectExecution = undefined;
    reject(new Error("fixture failure after accepted write"));
  }

  public emitOutput(data: string): void {
    this.#options.onOutput(data);
  }

  public writeInput(): void {}
  public writeSecret(): void {}
  public finishSensitiveOutput(): void {}
  public sendControl(delivery: ControlDelivery): void {
    this.controlWrites.push(delivery);
  }
  public resize(): void {}
  public close(): void {}
}
