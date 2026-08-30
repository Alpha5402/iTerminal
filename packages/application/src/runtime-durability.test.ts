import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import type { Approval } from "@iterminal/domain";
import type {
  DurableApprovalMutationResult,
  DurableApprovalRequest,
  DurableExecuteAdmission,
  DurableExecuteAdmissionResult,
  RuntimeDurability,
  RuntimeOwnerIdentity,
  SessionFence,
  SessionLease,
  ShellExecuteCallbacks,
  ShellExecutionResult,
  ShellExecutor,
  ShellExecutorFactory,
} from "./index.js";
import type { EventPage } from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import { describe, expect, it } from "vitest";

import { RuntimeService } from "./runtime-service.js";

const actor = {
  client: "durability-test",
  id: "agent-durability",
  principal: "durability-test",
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  type: "agent" as const,
};

describe("Runtime durable write-ahead boundary", () => {
  it("keeps external Execute reserved until one idempotent owner dispatch", async () => {
    const durability = new ControlledDurability();
    const executor = new RecordingExecutor();
    const runtime = new RuntimeService(new MemoryRuntimeStore(), new RecordingFactory(executor), {
      durability,
      executionDispatch: "external",
      ownerId: "owner-durability-test",
    });
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    const admitted = await runtime.startExecute({
      actor,
      command: "python3 -q",
      idempotencyKey: "external-dispatch",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    expect(executor.commands).toEqual([]);
    expect(runtime.getSession(session.id).status).toBe("RESERVED");

    const [left, right] = await Promise.all([
      runtime.dispatchExecution(admitted.execution.id),
      runtime.dispatchExecution(admitted.execution.id),
    ]);
    expect(left.execution.id).toBe(admitted.execution.id);
    expect(right.execution.id).toBe(admitted.execution.id);
    expect(executor.commands).toEqual(["python3 -q"]);
    expect(durability.writeAttempts).toBe(1);
    await runtime.closeSession(session.id, session.generation);
  });

  it("does not write Execute to the Shell when durable admission fails", async () => {
    const durability = new ControlledDurability();
    const executor = new RecordingExecutor();
    const runtime = new RuntimeService(new MemoryRuntimeStore(), new RecordingFactory(executor), {
      durability,
      ownerId: "owner-durability-test",
    });
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    durability.failExecute = true;

    await expect(
      runtime.startExecute({
        actor,
        command: "touch must-not-run",
        idempotencyKey: "execute-before-write",
        sessionGeneration: session.generation,
        sessionId: session.id,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });

    expect(executor.commands).toEqual([]);
    expect(executor.closed).toBe(true);
    expect(runtime.getSession(session.id)).toMatchObject({
      actionSequence: 0,
      status: "BROKEN",
    });
  });

  it("does not write Input when its immutable Action cannot be persisted", async () => {
    const durability = new ControlledDurability();
    const executor = new RecordingExecutor();
    const runtime = new RuntimeService(new MemoryRuntimeStore(), new RecordingFactory(executor), {
      durability,
      ownerId: "owner-durability-test",
    });
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    const started = await runtime.startExecute({
      actor,
      command: "python3 -q",
      idempotencyKey: "interactive-execute",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await started.started;
    durability.failInteraction = true;

    await expect(
      runtime.sendInput({
        actor,
        data: "print('must-not-run')\n",
        idempotencyKey: "input-before-write",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });

    expect(executor.inputs).toEqual([]);
    expect(executor.closed).toBe(true);
    expect(runtime.getSession(session.id)).toMatchObject({
      actionSequence: 1,
      status: "BROKEN",
    });
  });

  it("trips every live Session for an owner-wide durability outage and admits only after recovery", async () => {
    const durability = new ControlledDurability();
    const factory = new TrackingFactory();
    const runtime = new RuntimeService(new MemoryRuntimeStore(), factory, {
      durability,
      ownerId: "owner-wide-durability-test",
    });
    const left = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    const right = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    durability.failExecute = true;

    await expect(
      runtime.startExecute({
        actor,
        command: "touch must-not-run",
        idempotencyKey: "owner-outage",
        sessionGeneration: left.generation,
        sessionId: left.id,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });

    expect(runtime.isDurabilityHealthy()).toBe(false);
    expect(runtime.getSession(left.id).status).toBe("BROKEN");
    expect(runtime.getSession(right.id).status).toBe("BROKEN");
    expect(factory.executors.slice(0, 2).every((executor) => executor.closed)).toBe(true);
    await expect(
      runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });

    durability.failExecute = false;
    await runtime.recoverDurableOwner("database connection recovered");
    expect(runtime.isDurabilityHealthy()).toBe(true);
    const replacement = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    expect(replacement.status).toBe("READY");
    expect(runtime.getSession(left.id).status).toBe("BROKEN");
    expect(runtime.getSession(right.id).status).toBe("BROKEN");
    await runtime.closeSession(replacement.id, replacement.generation);
  });

  it("keeps a durable state conflict scoped to its Session", async () => {
    const durability = new ControlledDurability();
    const factory = new TrackingFactory();
    const runtime = new RuntimeService(new MemoryRuntimeStore(), factory, {
      durability,
      ownerId: "owner-session-conflict-test",
    });
    const conflicted = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    const healthy = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    durability.executeError = new RuntimeError(
      "DELIVERY_UNKNOWN",
      "injected Session-scoped durable conflict",
    );

    await expect(
      runtime.startExecute({
        actor,
        command: "true",
        idempotencyKey: "session-conflict",
        sessionGeneration: conflicted.generation,
        sessionId: conflicted.id,
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });

    expect(runtime.isDurabilityHealthy()).toBe(true);
    expect(runtime.getSession(conflicted.id).status).toBe("BROKEN");
    expect(runtime.getSession(healthy.id).status).toBe("READY");
    expect(factory.executors[0]?.closed).toBe(true);
    expect(factory.executors[1]?.closed).toBe(false);
    await runtime.closeSession(healthy.id, healthy.generation);
  });

  it("does not publish a recertified checkpoint before durable fork admission", async () => {
    const durability = new ControlledDurability();
    const store = new MemoryRuntimeStore();
    const runtime = new RuntimeService(store, new RecordingFactory(new RecordingExecutor()), {
      durability,
      ownerId: "owner-fork-admission-test",
    });
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    const checkpoint = runtime.getSessionCheckpoint(session.id, session.generation);
    durability.forkError = new RuntimeError(
      "CHECKPOINT_CHANGED",
      "injected durable fork conflict",
      {},
      true,
    );

    await expect(
      runtime.forkSession({
        actor,
        allowStale: false,
        expectedCheckpointVersion: checkpoint.version,
        idempotencyKey: "fork-before-admission",
        sessionGeneration: session.generation,
        sessionId: session.id,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_CHANGED" });

    expect(runtime.getSessionCheckpoint(session.id, session.generation).version).toBe(
      checkpoint.version,
    );
    expect(runtime.listSessions()).toHaveLength(1);
    expect(runtime.getSession(session.id).status).toBe("READY");
    expect(
      store.queryEvents(session.id, session.generation, 0, 100).map((event) => event.type),
    ).toEqual(expect.arrayContaining(["session.fork_failed"]));
    expect(
      store.queryEvents(session.id, session.generation, 0, 100).map((event) => event.type),
    ).not.toEqual(expect.arrayContaining(["session.fork_requested"]));
    await runtime.closeSession(session.id, session.generation);
  });
});

class RecordingFactory implements ShellExecutorFactory {
  public constructor(private readonly executor: RecordingExecutor) {}

  public create(): Promise<ShellExecutor> {
    return Promise.resolve(this.executor);
  }
}

class TrackingFactory implements ShellExecutorFactory {
  public readonly executors: RecordingExecutor[] = [];

  public create(): Promise<ShellExecutor> {
    const executor = new RecordingExecutor();
    this.executors.push(executor);
    return Promise.resolve(executor);
  }
}

class RecordingExecutor implements ShellExecutor {
  public readonly shell = "zsh" as const;
  public readonly shellPid = process.pid;
  public readonly commands: string[] = [];
  public readonly inputs: string[] = [];
  public closed = false;

  public checkpoint(): Readonly<{
    cwd: string;
    filteredEnvironment: Readonly<Record<string, string>>;
  }> {
    return { cwd: "/tmp", filteredEnvironment: {} };
  }

  public execute(command: string, callbacks: ShellExecuteCallbacks): Promise<ShellExecutionResult> {
    this.commands.push(command);
    callbacks.onStarted(command);
    return new Promise(() => undefined);
  }

  public writeInput(data: string): void {
    this.inputs.push(data);
  }

  public writeSecret(data: string): void {
    this.inputs.push(data);
  }

  public finishSensitiveOutput(): void {}

  public sendControl(): void {}

  public resize(): void {}

  public close(): void {
    this.closed = true;
  }
}

class ControlledDurability implements RuntimeDurability {
  public executeError: RuntimeError | undefined;
  public forkError: RuntimeError | undefined;
  public failExecute = false;
  public failInteraction = false;
  public writeAttempts = 0;
  public interactionWriteAttempts = 0;
  #nextFencingToken = 1;

  public requestApproval(
    fence: SessionFence,
    input: DurableApprovalRequest,
  ): Promise<DurableApprovalMutationResult> {
    void fence;
    return Promise.resolve({ approval: input.approval, replayed: false });
  }

  public getApproval(): Promise<Approval> {
    return Promise.reject(unavailable());
  }

  public listApprovals(): Promise<readonly Approval[]> {
    return Promise.resolve([]);
  }

  public decideApproval(): Promise<DurableApprovalMutationResult> {
    return Promise.reject(unavailable());
  }

  public createSession(
    session: { readonly generation: number; readonly id: string },
    _events: readonly unknown[],
    owner: RuntimeOwnerIdentity,
  ): Promise<{ readonly kind: "created"; readonly lease: SessionLease }> {
    return Promise.resolve({
      kind: "created",
      lease: this.#lease(session.id, session.generation, owner),
    });
  }

  public createForkSession(
    input: { readonly child: { readonly generation: number; readonly id: string } },
    owner: RuntimeOwnerIdentity,
  ): Promise<SessionLease> {
    return this.forkError === undefined
      ? Promise.resolve(this.#lease(input.child.id, input.child.generation, owner))
      : Promise.reject(this.forkError);
  }

  public renewSessionLeases(
    _owner: RuntimeOwnerIdentity,
    leases: readonly SessionFence[],
  ): Promise<readonly SessionLease[]> {
    return Promise.resolve(
      leases.map((lease) => ({
        ...lease,
        acquiredAt: new Date(0).toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        renewedAt: new Date().toISOString(),
        version: 2,
      })),
    );
  }

  public markSessionReady(): Promise<void> {
    return Promise.resolve();
  }

  public markSessionBroken(): Promise<void> {
    return Promise.resolve();
  }

  public closeSession(): Promise<void> {
    return Promise.resolve();
  }

  public acceptExecute(
    _fence: SessionFence,
    input: DurableExecuteAdmission,
  ): Promise<DurableExecuteAdmissionResult> {
    if (this.executeError !== undefined) return Promise.reject(this.executeError);
    if (this.failExecute) return Promise.reject(unavailable());
    return Promise.resolve({
      actionId: input.action.id,
      actionSequence: input.action.actionSequence,
      executionId: input.execution.id,
      replayed: false,
    });
  }

  public markExecutionRunning(): Promise<void> {
    return Promise.resolve();
  }

  public markExecutionWriteAttempted(): Promise<void> {
    this.writeAttempts += 1;
    return Promise.resolve();
  }

  public finishExecution(): Promise<void> {
    return Promise.resolve();
  }

  public failExecution(): Promise<void> {
    return Promise.resolve();
  }

  public acceptInteraction(): Promise<void> {
    return this.failInteraction ? Promise.reject(unavailable()) : Promise.resolve();
  }

  public acceptSecretInput(): Promise<void> {
    return this.failInteraction ? Promise.reject(unavailable()) : Promise.resolve();
  }

  public finishInteraction(): Promise<void> {
    return Promise.resolve();
  }

  public finishSensitiveInput(): Promise<void> {
    return Promise.resolve();
  }

  public acceptResize(): Promise<void> {
    return Promise.resolve();
  }

  public markResizeWriteAttempted(): Promise<void> {
    return Promise.resolve();
  }

  public finishResize(): Promise<void> {
    return Promise.resolve();
  }

  public saveInteractionState(): Promise<void> {
    return Promise.resolve();
  }

  public markInteractionWriteAttempted(): Promise<void> {
    this.interactionWriteAttempts += 1;
    return Promise.resolve();
  }

  public appendEvent(): Promise<void> {
    return Promise.resolve();
  }

  public appendOwnerEvent(): Promise<void> {
    return Promise.resolve();
  }

  public queryEvents(): Promise<EventPage> {
    return Promise.resolve({ events: [], truncated: false });
  }

  public recoverOwner(): Promise<{
    readonly brokenSessions: number;
    readonly rebuildableSessions: readonly [];
    readonly unknownExecutions: number;
  }> {
    return Promise.resolve({ brokenSessions: 0, rebuildableSessions: [], unknownExecutions: 0 });
  }

  #lease(sessionId: string, generation: number, owner: RuntimeOwnerIdentity): SessionLease {
    const now = new Date();
    return {
      acquiredAt: now.toISOString(),
      ...owner,
      fencingToken: (this.#nextFencingToken++).toString(),
      generation,
      leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      renewedAt: now.toISOString(),
      sessionId,
      version: 1,
    };
  }
}

function unavailable(): RuntimeError {
  return new RuntimeError("RUNTIME_UNAVAILABLE", "injected durable failure", {}, true);
}
