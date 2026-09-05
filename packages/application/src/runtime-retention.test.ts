import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CreateExecutorOptions,
  DurableActionReplay,
  DurableExecuteAdmission,
  RuntimeDurability,
  RuntimeRetentionLimits,
  SessionFence,
  ShellExecuteCallbacks,
  ShellExecutionResult,
  ShellExecutor,
  ShellExecutorFactory,
} from "@iterminal/application";
import { DEFAULT_RUNTIME_RETENTION_LIMITS, RuntimeService } from "@iterminal/application";
import type { ControlDelivery, ExecuteAction, Execution } from "@iterminal/domain";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import { agentActor } from "@iterminal/testkit";
import { afterEach, describe, expect, it } from "vitest";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

describe("Runtime bounded in-process retention", () => {
  it("releases settled Execute promises and lets a later V2 wait read terminal state", async () => {
    const factory = new ControlledFactory();
    const runtime = createRuntime(factory);
    const session = await createSession(runtime);
    const started = await runtime.startExecute({
      actor: agentActor,
      command: "printf done",
      idempotencyKey: "settled-cleanup",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await started.started;
    factory.latest().complete();
    await started.completion;
    await Promise.resolve();

    expect(runtime.retentionSnapshot().application).toMatchObject({
      completionPromises: 0,
      dispatchStates: 0,
      executionWaiters: 0,
      startedPromises: 0,
    });
    await expect(
      runtime.waitExecutionV2({ executionId: started.execution.id, waitMs: 30_000 }),
    ).resolves.toEqual({
      completed: true,
      executionId: started.execution.id,
      executionState: "COMPLETED",
    });
    await runtime.closeSession(session.id, session.generation);
    expect(runtime.retentionSnapshot().application.durableQueues).toBe(0);
  });

  it("releases independent waiters on cancel and close without controlling the PTY", async () => {
    const factory = new ControlledFactory();
    const runtime = createRuntime(factory);
    const session = await createSession(runtime);
    const started = await runtime.startExecute({
      actor: agentActor,
      command: "sleep fixture",
      idempotencyKey: "wait-close-cleanup",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await started.started;
    const cancelledController = new AbortController();
    const cancelled = runtime.waitExecutionV2(
      { executionId: started.execution.id, waitMs: 30_000 },
      cancelledController.signal,
    );
    const surviving = runtime.waitExecutionV2({
      executionId: started.execution.id,
      waitMs: 30_000,
    });
    expect(runtime.retentionSnapshot().application.executionWaiters).toBe(2);

    cancelledController.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.retentionSnapshot().application.executionWaiters).toBe(1);
    expect(factory.latest().controls).toEqual([]);

    await runtime.closeSession(session.id, session.generation);
    await expect(surviving).resolves.toMatchObject({
      completed: true,
      executionState: "UNKNOWN",
    });
    expect(factory.latest().controls).toEqual([]);
    expect(runtime.retentionSnapshot().application).toMatchObject({
      completionPromises: 0,
      dispatchStates: 0,
      executionWaiters: 0,
      startedPromises: 0,
    });
  });

  it("rejects memory-only ordinary Actions at capacity while preserving one Control and close", async () => {
    const factory = new ControlledFactory();
    const runtime = createRuntime(factory, {
      memoryOnlyActionBytes: 1024 * 1024,
      memoryOnlyActionEntries: 5,
      memoryOnlyControlReserveBytes: 64 * 1024,
      memoryOnlyControlReserveEntries: 1,
    });
    const session = await createSession(runtime);
    const started = await runtime.startExecute({
      actor: agentActor,
      command: "sleep fixture",
      idempotencyKey: "capacity-execute",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await started.started;
    for (let index = 0; index < 3; index += 1) {
      await runtime.sendInput({
        actor: agentActor,
        data: "x",
        idempotencyKey: `capacity-input-${index.toString()}`,
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      });
    }

    await expect(
      runtime.sendInput({
        actor: agentActor,
        data: "blocked",
        idempotencyKey: "capacity-input-blocked",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      }),
    ).rejects.toMatchObject({
      code: "BACKPRESSURE",
      details: { component: "runtime_memory_history", reserve: "ordinary" },
      retryable: false,
    });
    expect(factory.latest().inputs).toEqual(["x", "x", "x"]);

    await expect(
      runtime.sendControl({
        actor: agentActor,
        delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
        idempotencyKey: "capacity-control",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      }),
    ).resolves.toMatchObject({ status: "DELIVERED", type: "control" });
    expect(factory.latest().controls).toHaveLength(1);
    await expect(
      runtime.sendControl({
        actor: agentActor,
        delivery: { control: "ESC", mode: "TTY_CONTROL" },
        idempotencyKey: "capacity-control-exhausted",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      }),
    ).rejects.toMatchObject({ code: "BACKPRESSURE" });

    await expect(runtime.closeSession(session.id, session.generation)).resolves.toMatchObject({
      status: "CLOSED",
    });
    expect(runtime.retentionSnapshot().application).toMatchObject({
      completionPromises: 0,
      dispatchStates: 0,
      executionWaiters: 0,
      startedPromises: 0,
    });
  });

  it("reports a memory Event gap and rejects only cursors before the retained floor", async () => {
    const runtime = createRuntime(new ControlledFactory(), {
      eventBytesPerGeneration: 1024 * 1024,
      eventEntriesPerGeneration: 1,
    });
    const session = await createSession(runtime);
    const fresh = await runtime.queryEvents(session.id, session.generation, 0, 100);
    expect(fresh.retention).toMatchObject({ gap: true, source: "memory" });
    const minimum = fresh.retention?.minimumAvailableSequence;
    if (minimum === undefined || minimum < 2) throw new Error("Fixture did not advance retention");

    await expect(
      runtime.queryEvents(session.id, session.generation, minimum - 2, 100),
    ).rejects.toMatchObject({
      code: "RESYNC_REQUIRED",
      details: { minimumAvailableSequence: minimum },
    });
    await expect(
      runtime.queryEvents(session.id, session.generation, minimum - 1, 100),
    ).resolves.toMatchObject({ retention: { gap: false, minimumAvailableSequence: minimum } });
    await runtime.closeSession(session.id, session.generation);
  });

  it("keeps durable history bounded across thousands of terminal Actions and pins the active Execute", async () => {
    const durability = new TestDurability();
    const factory = new ControlledFactory();
    const runtime = createRuntime(
      factory,
      {
        durableHistoryBytes: 64 * 1024,
        durableHistoryEntries: 8,
        eventBytesPerGeneration: 64 * 1024,
        eventEntriesPerGeneration: 32,
      },
      durability.port,
    );
    const session = await createSession(runtime);
    const started = await runtime.startExecute({
      actor: agentActor,
      command: "long-running fixture",
      idempotencyKey: "active-pinned",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await started.started;
    const rssBefore = process.memoryUsage().rss;
    for (let index = 0; index < 2_000; index += 1) {
      await runtime.sendInput({
        actor: agentActor,
        data: "x",
        idempotencyKey: `bounded-input-${index.toString()}`,
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      });
    }
    const rssAfter = process.memoryUsage().rss;
    const snapshot = runtime.retentionSnapshot();
    process.stdout.write(
      `B07_RSS before=${rssBefore.toString()} after=${rssAfter.toString()} delta=${(
        rssAfter - rssBefore
      ).toString()}\n`,
    );

    expect(runtime.getExecution(started.execution.id).status).toBe("RUNNING");
    expect(snapshot.store).toMatchObject({
      durableHistoryEntries: 8,
      events: 32,
      executions: 1,
    });
    expect(snapshot.store?.actions).toBeLessThanOrEqual(9);
    expect(snapshot.store?.idempotencyBindings).toBeLessThanOrEqual(9);
    expect(rssAfter - rssBefore).toBeLessThan(128 * 1024 * 1024);

    await runtime.closeSession(session.id, session.generation);
  }, 30_000);

  it("uses B06 durable replay after eviction without a second Shell command", async () => {
    const durability = new TestDurability();
    const factory = new ControlledFactory();
    const runtime = createRuntime(
      factory,
      { durableHistoryBytes: 1024 * 1024, durableHistoryEntries: 1 },
      durability.port,
    );
    const session = await createSession(runtime);
    const firstRequest = {
      actor: agentActor,
      command: "printf first",
      idempotencyKey: "evicted-replay",
      sessionGeneration: session.generation,
      sessionId: session.id,
    };
    const first = await runtime.startExecute(firstRequest);
    await first.started;
    factory.latest().complete();
    await first.completion;

    const second = await runtime.startExecute({
      ...firstRequest,
      command: "printf second",
      idempotencyKey: "eviction-trigger",
    });
    await second.started;
    factory.latest().complete();
    await second.completion;
    await Promise.resolve();
    expect(runtime.retentionSnapshot().store).toMatchObject({
      actions: 1,
      durableHistoryEntries: 1,
      executions: 1,
    });

    const replay = await runtime.startExecute(firstRequest);
    expect(replay.action.id).toBe(first.action.id);
    expect(replay.execution.id).toBe(first.execution.id);
    expect(factory.commands).toEqual(["printf first", "printf second"]);
    await runtime.closeSession(session.id, session.generation);
  });
});

function createRuntime(
  factory: ControlledFactory,
  overrides: Partial<RuntimeRetentionLimits> = {},
  durability?: RuntimeDurability,
): RuntimeService {
  return new RuntimeService(new MemoryRuntimeStore(), factory, {
    ...(durability === undefined ? {} : { durability, ownerId: "owner-runtime-retention" }),
    retention: { ...DEFAULT_RUNTIME_RETENTION_LIMITS, ...overrides },
  });
}

async function createSession(runtime: RuntimeService) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "iterminal-runtime-retention-"));
  fixtureRoots.push(fixtureRoot);
  const workspaceRoot = join(fixtureRoot, "workspace");
  mkdirSync(workspaceRoot);
  return runtime.createSession({ shell: "zsh", workspaceRoot });
}

class ControlledFactory implements ShellExecutorFactory {
  public readonly commands: string[] = [];
  readonly #executors: ControlledExecutor[] = [];

  public create(options: CreateExecutorOptions): Promise<ShellExecutor> {
    const executor = new ControlledExecutor(options, this.commands);
    this.#executors.push(executor);
    return Promise.resolve(executor);
  }

  public latest(): ControlledExecutor {
    const executor = this.#executors.at(-1);
    if (executor === undefined) throw new Error("No Executor fixture");
    return executor;
  }
}

class ControlledExecutor implements ShellExecutor {
  public readonly controls: unknown[] = [];
  public readonly inputs: string[] = [];
  public readonly shell = "zsh" as const;
  public readonly shellPid = 770_001;
  readonly #commands: string[];
  readonly #options: CreateExecutorOptions;
  #completion: ((result: ShellExecutionResult) => void) | undefined;

  public constructor(options: CreateExecutorOptions, commands: string[]) {
    this.#commands = commands;
    this.#options = options;
  }

  public checkpoint() {
    return { cwd: this.#options.workspaceRoot, filteredEnvironment: {} };
  }

  public close(): void {
    // Fixture close intentionally leaves the held completion unresolved; RuntimeService settles it.
  }

  public execute(command: string, callbacks: ShellExecuteCallbacks): Promise<ShellExecutionResult> {
    this.#commands.push(command);
    callbacks.onWriteAccepted?.();
    callbacks.onStarted(command);
    return new Promise((resolve) => {
      this.#completion = resolve;
    });
  }

  public finishSensitiveOutput(): void {}

  public complete(): void {
    const completion = this.#completion;
    if (completion === undefined) throw new Error("No active fixture Execution");
    this.#completion = undefined;
    completion({
      cwd: this.#options.workspaceRoot,
      exitCode: 0,
      filteredEnvironment: {},
      output: "fixture output",
      outputTruncated: false,
    });
  }

  public resize(): void {}

  public sendControl(delivery: ControlDelivery): void {
    this.controls.push(delivery);
  }

  public writeInput(data: string): void {
    this.inputs.push(data);
  }

  public writeSecret(): void {}
}

class TestDurability {
  readonly #executions = new Map<
    string,
    Readonly<{ action: ExecuteAction; execution: Execution }>
  >();

  public readonly port: RuntimeDurability;

  public constructor() {
    const implemented = {
      acceptExecute: (_fence: SessionFence, input: DurableExecuteAdmission) =>
        Promise.resolve({
          actionId: input.action.id,
          actionSequence: input.action.actionSequence,
          executionId: input.execution.id,
          replayed: false,
        }),
      createSession: (session: Readonly<{ id: string; generation: number; ownerId: string }>) =>
        Promise.resolve({
          kind: "created" as const,
          lease: {
            acquiredAt: "2026-09-05T00:00:00.000Z",
            epoch: 1,
            fencingToken: "fence-runtime-retention",
            generation: session.generation,
            instanceId: `in_process_${process.pid.toString()}`,
            leaseExpiresAt: "2026-09-05T01:00:00.000Z",
            ownerId: session.ownerId,
            renewedAt: "2026-09-05T00:00:00.000Z",
            sessionId: session.id,
            version: 1,
          },
        }),
      finishExecution: (input: { action: ExecuteAction; execution: Execution }) => {
        this.#executions.set(input.action.idempotencyKey, {
          action: structuredClone(input.action),
          execution: structuredClone(input.execution),
        });
        return Promise.resolve();
      },
      lookupAction: () => Promise.resolve(undefined),
      lookupActionReplay: (request: {
        idempotencyKey: string;
      }): Promise<DurableActionReplay | undefined> => {
        const fact = this.#executions.get(request.idempotencyKey);
        return Promise.resolve(
          fact === undefined
            ? undefined
            : {
                action: structuredClone(fact.action),
                execution: structuredClone(fact.execution),
                kind: "full",
              },
        );
      },
    };
    this.port = new Proxy(implemented, {
      get(target, property, receiver) {
        if (Reflect.has(target, property))
          return Reflect.get(target, property, receiver) as unknown;
        return () => Promise.resolve(undefined);
      },
    }) as unknown as RuntimeDurability;
  }
}
