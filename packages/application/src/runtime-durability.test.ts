import { createHash } from "node:crypto";

import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import type { Approval, Execution, SessionAction } from "@iterminal/domain";
import type {
  DurableApprovalMutationResult,
  DurableActionReplay,
  DurableApprovalRequest,
  DurableExecuteAdmission,
  DurableExecuteAdmissionResult,
  DurableSessionEvent,
  CreateExecutorOptions,
  RuntimeDurability,
  HistoryLookupRequest,
  HistoryLookupResult,
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
  it("coalesces callback-sized PTY output with hard UTF-8 byte and time bounds", async () => {
    const durability = new ControlledDurability();
    const executor = new RecordingExecutor();
    const store = new MemoryRuntimeStore();
    const runtime = new RuntimeService(store, new RecordingFactory(executor), {
      durability,
      ownerId: "owner-output-coalescing-test",
    });
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });

    for (let index = 0; index < 8; index += 1) executor.emitOutput("x".repeat(1024));
    executor.emitOutput("鲸".repeat(3000));
    await waitUntil(() => durability.outputEvents.length === 3);

    expect(durability.outputEvents.map((event) => event.payload.byteLength)).toEqual([
      8192, 8190, 810,
    ]);
    expect(durability.outputEvents.map((event) => event.payload.data).join("")).toBe(
      `${"x".repeat(8192)}${"鲸".repeat(3000)}`,
    );
    expect(durability.outputEvents.at(-1)?.payload.screenVersion).toBe(9);
    expect(
      store
        .queryEvents(session.id, session.generation, 0, 100)
        .filter((event) => event.type === "terminal.pty_output")
        .map((event) => event.id),
    ).toEqual(durability.outputEvents.map((event) => event.id));
    await runtime.closeSession(session.id, session.generation);
  });

  it("flushes output before Execution boundaries and preserves exact attribution", async () => {
    const durability = new ControlledDurability();
    const executor = new RecordingExecutor();
    const store = new MemoryRuntimeStore();
    const runtime = new RuntimeService(store, new RecordingFactory(executor), {
      durability,
      ownerId: "owner-output-boundary-test",
    });
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    executor.emitOutput("ready-tail");
    const started = await runtime.startExecute({
      actor,
      command: "printf execution-output",
      idempotencyKey: "output-attribution",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await within(started.started, "Execution start");
    executor.emitOutput("execution-");
    executor.emitOutput("tail");
    executor.complete();
    await within(started.completion, "Execution completion");

    const events = store.queryEvents(session.id, session.generation, 0, 100);
    const outputs = events.filter((event) => event.type === "terminal.pty_output");
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toMatchObject({ payload: { data: "ready-tail" } });
    expect(outputs[0]?.actionId).toBeUndefined();
    expect(outputs[0]?.executionId).toBeUndefined();
    expect(outputs[1]).toMatchObject({
      actionId: started.action.id,
      actor: { id: actor.id },
      executionId: started.execution.id,
      payload: { data: "execution-tail" },
    });
    expect(events.findIndex((event) => event.id === outputs[0]?.id)).toBeLessThan(
      events.findIndex((event) => event.type === "action.accepted"),
    );
    expect(events.findIndex((event) => event.id === outputs[1]?.id)).toBeLessThan(
      events.findIndex((event) => event.type === "execution.completed"),
    );
    await within(runtime.closeSession(session.id, session.generation), "Session close");
  });

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

  it("keeps terminal Execute history and replay stable after an artificial memory eviction", async () => {
    const durability = new ControlledDurability();
    const executor = new RecordingExecutor();
    const store = new EvictingStore();
    const runtime = new RuntimeService(store, new RecordingFactory(executor), {
      durability,
      ownerId: "owner-history-execute-test",
    });
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    const request = {
      actor,
      command: "printf durable-history",
      idempotencyKey: "durable-execute-replay",
      sessionGeneration: session.generation,
      sessionId: session.id,
    };
    const started = await runtime.startExecute(request);
    await started.started;
    executor.complete();
    const completed = await started.completion;
    const target = { executionId: completed.id, type: "execution" as const };
    const before = await runtime.lookupHistory({
      actor,
      generation: session.generation,
      sessionId: session.id,
      target,
    });
    expect(before).toMatchObject({ kind: "full", source: "live" });

    store.hideAction(started.action);
    store.hideExecution(completed);
    const after = await runtime.lookupHistory({
      actor,
      generation: session.generation,
      sessionId: session.id,
      target,
    });
    expect(after).toMatchObject({ kind: "full", source: "durable" });
    if (before.kind !== "full" || after.kind !== "full") throw new Error("history fact missing");
    expect(after.fact).toEqual(before.fact);

    const replayed = await runtime.startExecute(request);
    expect(replayed.action.id).toBe(started.action.id);
    expect(replayed.execution.id).toBe(started.execution.id);
    expect(executor.commands).toEqual([request.command]);
    expect(runtime.getSession(session.id).actionSequence).toBe(started.action.actionSequence);
    await runtime.closeSession(session.id, session.generation);
  });

  it("replays evicted Input and Control without a second PTY side effect and rejects changed payload", async () => {
    const durability = new ControlledDurability();
    const executor = new RecordingExecutor();
    const store = new EvictingStore();
    const runtime = new RuntimeService(store, new RecordingFactory(executor), {
      durability,
      ownerId: "owner-history-interaction-test",
    });
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    const started = await runtime.startExecute({
      actor,
      command: "interactive",
      idempotencyKey: "history-interactive-execute",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await started.started;
    const inputRequest = {
      actor,
      data: "first input\n",
      idempotencyKey: "history-input",
      sessionGeneration: session.generation,
      sessionId: session.id,
      targetExecutionId: started.execution.id,
    };
    const input = await runtime.sendInput(inputRequest);
    store.hideAction(input);
    expect((await runtime.sendInput(inputRequest)).id).toBe(input.id);
    expect(executor.inputs).toEqual([inputRequest.data]);
    await expect(
      runtime.sendInput({ ...inputRequest, data: "changed input\n" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(executor.inputs).toEqual([inputRequest.data]);

    const controlRequest = {
      actor,
      delivery: { control: "ESC" as const, mode: "TTY_CONTROL" as const },
      idempotencyKey: "history-control",
      sessionGeneration: session.generation,
      sessionId: session.id,
      targetExecutionId: started.execution.id,
    };
    const control = await runtime.sendControl(controlRequest);
    store.hideAction(control);
    expect((await runtime.sendControl(controlRequest)).id).toBe(control.id);
    expect(executor.controls).toHaveLength(1);
    await expect(
      runtime.sendControl({
        ...controlRequest,
        delivery: { control: "CTRL_D", mode: "TTY_CONTROL" },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(executor.controls).toHaveLength(1);
    await runtime.closeSession(session.id, session.generation);
  });

  it("rejects immutable actor drift on in-memory Secret Input and Resize replays", async () => {
    const durability = new ControlledDurability();
    const executor = new RecordingExecutor();
    const store = new MemoryRuntimeStore();
    const runtime = new RuntimeService(store, new RecordingFactory(executor), {
      durability,
      ownerId: "owner-history-actor-test",
    });
    const human = {
      ...actor,
      capabilities: ACTOR_CAPABILITY_PROFILES.human,
      id: "human-history-actor",
      type: "human" as const,
    };
    const drifted = { ...human, principal: "different-principal" };
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    const started = await runtime.startExecute({
      actor: human,
      command: "interactive",
      idempotencyKey: "history-actor-execute",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await started.started;

    const resizeRequest = {
      actor: human,
      columns: 81,
      expectedGeometryVersion: 1,
      idempotencyKey: "history-actor-resize",
      rows: 24,
      sessionGeneration: session.generation,
      sessionId: session.id,
    };
    const resizeAction: SessionAction = {
      acceptedAt: new Date(0).toISOString(),
      actionSequence: 2,
      actor: human,
      columns: resizeRequest.columns,
      expectedGeometryVersion: resizeRequest.expectedGeometryVersion,
      id: "act-history-actor-resize",
      idempotencyKey: resizeRequest.idempotencyKey,
      requestHash: requestHashForTest({
        columns: resizeRequest.columns,
        expectedGeometryVersion: resizeRequest.expectedGeometryVersion,
        rows: resizeRequest.rows,
      }),
      rows: resizeRequest.rows,
      sessionGeneration: session.generation,
      sessionId: session.id,
      status: "DELIVERED",
      type: "resize",
    };
    store.saveAction(resizeAction);
    store.bindIdempotency(
      `${session.id}:${human.id}`,
      resizeRequest.idempotencyKey,
      resizeAction.id,
    );
    expect((await runtime.resizeTerminal(resizeRequest)).id).toBe(resizeAction.id);
    await expect(
      runtime.resizeTerminal({ ...resizeRequest, actor: drifted }),
    ).rejects.toMatchObject({
      code: "ACTOR_IDENTITY_CONFLICT",
    });

    const secretRequest = {
      actor: human,
      data: "secret-test-value\r",
      idempotencyKey: "history-actor-secret",
      sessionGeneration: session.generation,
      sessionId: session.id,
      targetExecutionId: started.execution.id,
    };
    const secret = await runtime.beginSecretInput(secretRequest);
    await expect(
      runtime.beginSecretInput({ ...secretRequest, actor: drifted, data: "another-value\r" }),
    ).rejects.toMatchObject({ code: "ACTOR_IDENTITY_CONFLICT" });
    const sensitive = runtime.getSensitiveInput({
      actor: human,
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    if (sensitive === undefined) throw new Error("Sensitive fixture was not created");
    await runtime.finishSensitiveInput({
      actor: human,
      expectedVersion: sensitive.version,
      idempotencyKey: "history-actor-secret-finish",
      outcome: "cancelled",
      sensitiveInputId: secret.sensitiveInputId,
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await runtime.closeSession(session.id, session.generation);
  });

  it("does not treat a durable-only active Action or a cross-generation key as new", async () => {
    const durability = new ControlledDurability();
    const executor = new RecordingExecutor();
    const store = new EvictingStore();
    const runtime = new RuntimeService(store, new RecordingFactory(executor), {
      durability,
      ownerId: "owner-history-active-test",
    });
    const session = await runtime.createSession({ shell: "zsh", workspaceRoot: "/tmp" });
    const request = {
      actor,
      command: "still-active",
      idempotencyKey: "active-durable-replay",
      sessionGeneration: session.generation,
      sessionId: session.id,
    };
    const started = await runtime.startExecute(request);
    await started.started;
    store.hideAction(started.action);
    store.hideExecution(started.execution);

    await expect(runtime.startExecute(request)).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      details: { reason: "live_owner_required" },
    });
    await expect(
      runtime.startExecute({ ...request, sessionGeneration: session.generation + 1 }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      details: { reason: "generation_changed" },
    });
    expect(executor.commands).toEqual([request.command]);
    store.restoreAction(started.action);
    store.restoreExecution(started.execution);
    await runtime.closeSession(session.id, session.generation);
  });

  it("classifies compacted, missing, timeout, and durable-only active history without mutation", async () => {
    const durability = new ControlledDurability();
    const runtime = new RuntimeService(
      new MemoryRuntimeStore(),
      new RecordingFactory(new RecordingExecutor()),
      { durability, ownerId: "owner-history-result-test" },
    );
    const base = {
      actor,
      generation: 1,
      sessionId: "ses-history-result",
      target: { idempotencyKey: "history-key", type: "action" as const },
    };
    durability.historyLookup = (request) =>
      Promise.resolve({
        fact: {
          acceptedAt: new Date(0).toISOString(),
          actionId: "act-compacted",
          actionStatus: "COMPLETED",
          actionType: "execute",
          executionId: "exe-compacted",
          executionStatus: "COMPLETED",
          targetType: "action",
        },
        generation: request.generation,
        kind: "compacted",
        retention: { expiredAt: new Date(1).toISOString(), state: "expired" },
        sessionId: request.sessionId,
        target: request.target,
      });
    expect(await runtime.lookupHistory(base)).toMatchObject({
      kind: "compacted",
      retention: { state: "expired" },
    });

    durability.historyLookup = () => Promise.resolve(undefined);
    expect(await runtime.lookupHistory(base)).toMatchObject({ kind: "not_found" });

    durability.historyLookup = () =>
      Promise.reject(
        new RuntimeError("ACTOR_IDENTITY_CONFLICT", "injected immutable identity mismatch"),
      );
    expect(await runtime.lookupHistory(base)).toMatchObject({ kind: "not_found" });

    durability.historyLookup = () =>
      Promise.reject(Object.assign(new Error("statement timeout"), { code: "57014" }));
    expect(await runtime.lookupHistory(base)).toMatchObject({
      kind: "unavailable",
      reason: "durability_timeout",
    });

    durability.historyLookup = (request) =>
      Promise.resolve({
        fact: {
          acceptedAt: new Date(0).toISOString(),
          actionId: "act-active-execute",
          actionStatus: "RUNNING",
          actionType: "execute",
          executionId: "exe-active",
          executionStatus: "RUNNING",
          targetType: "action",
        },
        generation: request.generation,
        kind: "full",
        sessionId: request.sessionId,
        source: "durable",
        target: request.target,
      });
    expect(await runtime.lookupHistory(base)).toMatchObject({
      kind: "unavailable",
      reason: "durability_unavailable",
    });

    durability.historyLookup = (request) =>
      Promise.resolve({
        fact: {
          acceptedAt: new Date(0).toISOString(),
          actionId: "act-active-control",
          actionStatus: "ACCEPTED",
          actionType: "control",
          targetType: "action",
        },
        generation: request.generation,
        kind: "full",
        sessionId: request.sessionId,
        source: "durable",
        target: request.target,
      });
    expect(await runtime.lookupHistory(base)).toMatchObject({
      kind: "unavailable",
      reason: "durability_unavailable",
    });

    durability.historyLookup = (request) =>
      Promise.resolve({
        fact: {
          acceptedAt: new Date(0).toISOString(),
          actionId: "act-active",
          actionStatus: "RUNNING",
          executionId: "exe-active",
          executionStatus: "RUNNING",
          targetType: "execution",
        },
        generation: request.generation,
        kind: "full",
        sessionId: request.sessionId,
        source: "durable",
        target: request.target,
      });
    expect(
      await runtime.lookupHistory({
        ...base,
        target: { executionId: "exe-active", type: "execution" },
      }),
    ).toMatchObject({ kind: "unavailable", reason: "durability_unavailable" });
  });
});

function requestHashForTest(value: Readonly<Record<string, unknown>>): string {
  const canonical = `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${JSON.stringify(item)}`)
    .join(",")}}`;
  return createHash("sha256").update(canonical).digest("hex");
}

class RecordingFactory implements ShellExecutorFactory {
  public constructor(private readonly executor: RecordingExecutor) {}

  public create(options: CreateExecutorOptions): Promise<ShellExecutor> {
    this.executor.bindOutput(options.onOutput);
    return Promise.resolve(this.executor);
  }
}

class TrackingFactory implements ShellExecutorFactory {
  public readonly executors: RecordingExecutor[] = [];

  public create(options: CreateExecutorOptions): Promise<ShellExecutor> {
    const executor = new RecordingExecutor();
    executor.bindOutput(options.onOutput);
    this.executors.push(executor);
    return Promise.resolve(executor);
  }
}

class EvictingStore extends MemoryRuntimeStore {
  readonly #hiddenActions = new Set<string>();
  readonly #hiddenExecutions = new Set<string>();

  public hideAction(action: SessionAction): void {
    this.#hiddenActions.add(action.id);
  }

  public hideExecution(execution: Execution): void {
    this.#hiddenExecutions.add(execution.id);
  }

  public restoreAction(action: SessionAction): void {
    this.#hiddenActions.delete(action.id);
  }

  public restoreExecution(execution: Execution): void {
    this.#hiddenExecutions.delete(execution.id);
  }

  public override getAction(actionId: string): SessionAction | undefined {
    return this.#hiddenActions.has(actionId) ? undefined : super.getAction(actionId);
  }

  public override getActionByIdempotency(
    scope: string,
    idempotencyKey: string,
  ): SessionAction | undefined {
    const action = super.getActionByIdempotency(scope, idempotencyKey);
    return action !== undefined && this.#hiddenActions.has(action.id) ? undefined : action;
  }

  public override getExecution(executionId: string): Execution | undefined {
    return this.#hiddenExecutions.has(executionId) ? undefined : super.getExecution(executionId);
  }
}

class RecordingExecutor implements ShellExecutor {
  public readonly shell = "zsh" as const;
  public readonly shellPid = process.pid;
  public readonly commands: string[] = [];
  public readonly inputs: string[] = [];
  public readonly controls: unknown[] = [];
  public closed = false;
  #complete: ((result: ShellExecutionResult) => void) | undefined;
  #onOutput: ((data: string) => void) | undefined;

  public bindOutput(onOutput: (data: string) => void): void {
    this.#onOutput = onOutput;
  }

  public emitOutput(data: string): void {
    this.#onOutput?.(data);
  }

  public complete(): void {
    this.#complete?.({
      cwd: "/tmp",
      exitCode: 0,
      filteredEnvironment: {},
      output: "",
      outputTruncated: false,
    });
  }

  public checkpoint(): Readonly<{
    cwd: string;
    filteredEnvironment: Readonly<Record<string, string>>;
  }> {
    return { cwd: "/tmp", filteredEnvironment: {} };
  }

  public execute(command: string, callbacks: ShellExecuteCallbacks): Promise<ShellExecutionResult> {
    this.commands.push(command);
    callbacks.onStarted(command);
    return new Promise((resolve) => {
      this.#complete = resolve;
    });
  }

  public writeInput(data: string): void {
    this.inputs.push(data);
  }

  public writeSecret(data: string): void {
    this.inputs.push(data);
  }

  public finishSensitiveOutput(): void {}

  public sendControl(delivery: unknown): void {
    this.controls.push(delivery);
  }

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
  public readonly outputEvents: DurableSessionEvent[] = [];
  public historyLookup:
    ((request: HistoryLookupRequest) => Promise<HistoryLookupResult | undefined>) | undefined;
  readonly #actionReplays = new Map<string, Extract<DurableActionReplay, { kind: "full" }>>();
  #nextFencingToken = 1;

  public lookupAction(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  public lookupHistory(request: HistoryLookupRequest): Promise<HistoryLookupResult | undefined> {
    if (this.historyLookup !== undefined) return this.historyLookup(request);
    const target = request.target;
    const replay =
      target.type === "action"
        ? this.#actionReplays.get(
            `${request.sessionId}:${request.actor.id}:${target.idempotencyKey}`,
          )
        : [...this.#actionReplays.values()].find(
            (candidate) => candidate.execution?.id === target.executionId,
          );
    if (
      replay === undefined ||
      replay.action.sessionGeneration !== request.generation ||
      replay.action.actor.id !== request.actor.id
    ) {
      return Promise.resolve(undefined);
    }
    const fact =
      request.target.type === "action"
        ? {
            acceptedAt: replay.action.acceptedAt,
            actionId: replay.action.id,
            actionStatus: replay.action.status,
            actionType: replay.action.type,
            ...(replay.execution === undefined ? {} : { executionId: replay.execution.id }),
            ...(replay.execution === undefined ? {} : { executionStatus: replay.execution.status }),
            targetType: "action" as const,
          }
        : replay.execution === undefined || replay.action.type !== "execute"
          ? undefined
          : {
              acceptedAt: replay.action.acceptedAt,
              actionId: replay.action.id,
              actionStatus: replay.action.status,
              executionId: replay.execution.id,
              executionStatus: replay.execution.status,
              ...(replay.execution.finishedAt === undefined
                ? {}
                : { finishedAt: replay.execution.finishedAt }),
              ...(replay.execution.startedAt === undefined
                ? {}
                : { startedAt: replay.execution.startedAt }),
              ...(replay.execution.exitCode === undefined
                ? {}
                : { exitCode: replay.execution.exitCode }),
              targetType: "execution" as const,
            };
    if (fact === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      fact,
      generation: request.generation,
      kind: "full",
      sessionId: request.sessionId,
      source: "durable",
      target: request.target,
    });
  }

  public lookupActionReplay(
    request: Parameters<RuntimeDurability["lookupAction"]>[0],
  ): Promise<DurableActionReplay | undefined> {
    return Promise.resolve(
      this.#actionReplays.get(`${request.sessionId}:${request.actor.id}:${request.idempotencyKey}`),
    );
  }

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
    this.#remember(input.action, input.execution);
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

  public acceptInteraction(
    _fence: SessionFence,
    action: Parameters<RuntimeDurability["acceptInteraction"]>[1],
  ): Promise<void> {
    if (this.failInteraction) return Promise.reject(unavailable());
    this.#remember(action);
    return Promise.resolve();
  }

  public acceptSecretInput(
    _fence: SessionFence,
    action: Parameters<RuntimeDurability["acceptSecretInput"]>[1],
  ): Promise<void> {
    if (this.failInteraction) return Promise.reject(unavailable());
    this.#remember(action);
    return Promise.resolve();
  }

  public finishInteraction(): Promise<void> {
    return Promise.resolve();
  }

  public finishSensitiveInput(): Promise<void> {
    return Promise.resolve();
  }

  public acceptResize(
    _fence: SessionFence,
    action: Parameters<RuntimeDurability["acceptResize"]>[1],
  ): Promise<void> {
    this.#remember(action);
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

  public appendEvent(_fence: SessionFence, event: DurableSessionEvent): Promise<void> {
    if (event.type === "terminal.pty_output") this.outputEvents.push(event);
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

  #remember(action: SessionAction, execution?: Execution): void {
    this.#actionReplays.set(`${action.sessionId}:${action.actor.id}:${action.idempotencyKey}`, {
      action,
      ...(execution === undefined ? {} : { execution }),
      kind: "full",
    });
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Runtime output aggregation");
}

async function within<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
