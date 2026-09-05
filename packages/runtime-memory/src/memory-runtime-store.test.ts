import {
  DEFAULT_RUNTIME_RETENTION_LIMITS,
  type RuntimeRetentionLimits,
} from "@iterminal/application";
import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import type {
  ControlAction,
  ExecuteAction,
  Execution,
  InputAction,
  Session,
} from "@iterminal/domain";
import { describe, expect, it } from "vitest";

import { MemoryRuntimeStore } from "./memory-runtime-store.js";

const actor = {
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  client: "memory-retention-test",
  id: "agent-memory-retention",
  principal: "memory-retention-test",
  type: "agent" as const,
};

describe("MemoryRuntimeStore retention", () => {
  it("atomically evicts persisted terminal Action, idempotency, and Execution pairs", () => {
    const store = configuredStore(true, { durableHistoryEntries: 1 });
    const session = createSession(store);
    const first = saveCompletedExecution(store, session, 1);
    store.settleActionHistory(first.action.id, first.execution.id);
    expect(store.getAction(first.action.id)).toBe(first.action);

    const second = saveCompletedExecution(store, session, 2);
    store.settleActionHistory(second.action.id, second.execution.id);

    expect(store.getAction(first.action.id)).toBeUndefined();
    expect(store.getExecution(first.execution.id)).toBeUndefined();
    expect(store.getActionByIdempotency(`${session.id}:${actor.id}`, "key-1")).toBeUndefined();
    expect(store.getAction(second.action.id)).toBe(second.action);
    expect(store.getExecution(second.execution.id)).toBe(second.execution);
    expect(store.retentionSnapshot()).toMatchObject({
      actions: 1,
      durableHistoryEntries: 1,
      executions: 1,
      idempotencyBindings: 1,
    });
  });

  it("never makes active or nonterminal facts eligible for durable eviction", () => {
    const store = configuredStore(true, { durableHistoryEntries: 1 });
    const session = createSession(store);
    const active = saveRunningExecution(store, session, 1);
    store.settleActionHistory(active.action.id, active.execution.id);

    for (let index = 2; index <= 4; index += 1) {
      const completed = saveCompletedExecution(store, session, index);
      store.settleActionHistory(completed.action.id, completed.execution.id);
    }

    expect(store.getAction(active.action.id)).toBe(active.action);
    expect(store.getExecution(active.execution.id)).toBe(active.execution);
    expect(store.retentionSnapshot()).toMatchObject({
      actions: 2,
      durableHistoryEntries: 1,
      executions: 2,
    });
  });

  it("reserves finite memory-only capacity for Control without forgetting accepted keys", () => {
    const store = configuredStore(false, {
      memoryOnlyActionBytes: 64 * 1024,
      memoryOnlyActionEntries: 4,
      memoryOnlyControlReserveBytes: 4 * 1024,
      memoryOnlyControlReserveEntries: 1,
    });
    const session = createSession(store);
    for (let index = 1; index <= 3; index += 1) {
      store.assertActionCapacity("input", 1);
      saveInput(store, session, index);
    }

    expect(() => store.assertActionCapacity("input", 1)).toThrowError(
      expect.objectContaining({ code: "BACKPRESSURE" }),
    );
    store.assertActionCapacity("control", 1);
    const control = saveControl(store, session, 4);
    expect(store.getActionByIdempotency(`${session.id}:${actor.id}`, "key-1")).toBeDefined();
    expect(store.getAction(control.id)).toBe(control);
    expect(() => store.assertActionCapacity("control", 1)).toThrowError(
      expect.objectContaining({ code: "BACKPRESSURE" }),
    );
  });

  it("keeps byte accounting stable when a terminal durable fact is settled again", () => {
    const store = configuredStore(true, { durableHistoryBytes: 1024 * 1024 });
    const session = createSession(store);
    const completed = saveCompletedExecution(store, session, 1);
    store.settleActionHistory(completed.action.id, completed.execution.id);
    const first = store.retentionSnapshot();

    store.settleActionHistory(completed.action.id, completed.execution.id);

    expect(store.retentionSnapshot()).toEqual(first);
  });

  it("accounts terminal Execution growth in memory-only byte admission", () => {
    const store = configuredStore(false, {
      memoryOnlyActionBytes: 8 * 1024,
      memoryOnlyActionEntries: 10,
      memoryOnlyControlReserveBytes: 1024,
      memoryOnlyControlReserveEntries: 1,
    });
    const session = createSession(store);
    const active = saveRunningExecution(store, session, 1);
    active.action.status = "COMPLETED";
    active.execution.status = "COMPLETED";
    active.execution.finishedAt = "2026-09-05T00:00:01.000Z";
    active.execution.output = "x".repeat(9 * 1024);
    store.settleActionHistory(active.action.id, active.execution.id);

    expect(store.retentionSnapshot().executionBytes).toBeGreaterThan(9 * 1024);
    expect(() => store.assertActionCapacity("input", 1)).toThrowError(
      expect.objectContaining({ code: "BACKPRESSURE" }),
    );
  });

  it("retains a bounded Event suffix with an explicit incremental floor", () => {
    const store = configuredStore(false, { eventEntriesPerGeneration: 3 });
    const session = createSession(store);
    for (let index = 1; index <= 5; index += 1) {
      store.appendEvent(session.id, session.generation, {
        id: `event-${index.toString()}`,
        observedAt: "2026-09-05T00:00:00.000Z",
        payload: { index },
        sessionGeneration: session.generation,
        sessionId: session.id,
        type: "fixture.event",
      });
    }

    expect(
      store.queryEvents(session.id, session.generation, 0, 10).map((event) => event.sequence),
    ).toEqual([3, 4, 5]);
    expect(store.eventRetention(session.id, session.generation)).toEqual({
      discardedThrough: 2,
      minimumAvailableSequence: 3,
    });
    expect(store.retentionSnapshot()).toMatchObject({ events: 3 });
  });

  it("drops an oversized Event without retaining a hidden payload reference", () => {
    const store = configuredStore(false, { eventBytesPerGeneration: 128 });
    const session = createSession(store);
    store.appendEvent(session.id, session.generation, {
      id: "oversized-event",
      observedAt: "2026-09-05T00:00:00.000Z",
      payload: { data: "x".repeat(1_024) },
      sessionGeneration: session.generation,
      sessionId: session.id,
      type: "fixture.oversized",
    });

    expect(store.queryEvents(session.id, session.generation, 0, 10)).toEqual([]);
    expect(store.eventRetention(session.id, session.generation)).toEqual({
      discardedThrough: 1,
      minimumAvailableSequence: 2,
    });
    expect(store.retentionSnapshot()).toMatchObject({ eventBytes: 0, events: 0 });
  });
});

function configuredStore(
  durable: boolean,
  overrides: Partial<RuntimeRetentionLimits>,
): MemoryRuntimeStore {
  const store = new MemoryRuntimeStore();
  store.configureRetention({
    durable,
    limits: { ...DEFAULT_RUNTIME_RETENTION_LIMITS, ...overrides },
  });
  return store;
}

function createSession(store: MemoryRuntimeStore): Session {
  const session: Session = {
    actionSequence: 0,
    createdAt: "2026-09-05T00:00:00.000Z",
    eventSequence: 0,
    generation: 1,
    id: "session-memory-retention",
    ownerId: "owner-memory-retention",
    screenVersion: 0,
    shell: "zsh",
    status: "READY",
    workspaceRoot: "/tmp",
  };
  store.createSession(session);
  return session;
}

function saveCompletedExecution(
  store: MemoryRuntimeStore,
  session: Session,
  index: number,
): Readonly<{
  action: ExecuteAction;
  execution: Execution;
}> {
  const action = executeAction(session, index, "COMPLETED");
  const execution: Execution = {
    actionId: action.id,
    actor,
    command: action.command,
    createdAt: action.acceptedAt,
    finishedAt: action.acceptedAt,
    id: action.executionId,
    sessionGeneration: session.generation,
    sessionId: session.id,
    status: "COMPLETED",
    version: 2,
  };
  store.saveAction(action);
  store.bindIdempotency(`${session.id}:${actor.id}`, action.idempotencyKey, action.id);
  store.saveExecution(execution);
  return { action, execution };
}

function saveRunningExecution(
  store: MemoryRuntimeStore,
  session: Session,
  index: number,
): Readonly<{
  action: ExecuteAction;
  execution: Execution;
}> {
  const action = executeAction(session, index, "RUNNING");
  const execution: Execution = {
    actionId: action.id,
    actor,
    command: action.command,
    createdAt: action.acceptedAt,
    id: action.executionId,
    sessionGeneration: session.generation,
    sessionId: session.id,
    status: "RUNNING",
    version: 2,
  };
  store.saveAction(action);
  store.bindIdempotency(`${session.id}:${actor.id}`, action.idempotencyKey, action.id);
  store.saveExecution(execution);
  return { action, execution };
}

function executeAction(
  session: Session,
  index: number,
  status: "COMPLETED" | "RUNNING",
): ExecuteAction {
  return {
    acceptedAt: "2026-09-05T00:00:00.000Z",
    actionSequence: index,
    actor,
    command: `printf ${index.toString()}`,
    executionId: `execution-${index.toString()}`,
    id: `action-${index.toString()}`,
    idempotencyKey: `key-${index.toString()}`,
    requestHash: `hash-${index.toString()}`,
    sessionGeneration: session.generation,
    sessionId: session.id,
    status,
    type: "execute",
  };
}

function saveInput(store: MemoryRuntimeStore, session: Session, index: number): InputAction {
  const action: InputAction = {
    acceptedAt: "2026-09-05T00:00:00.000Z",
    actionSequence: index,
    actor,
    data: "x",
    id: `action-${index.toString()}`,
    idempotencyKey: `key-${index.toString()}`,
    requestHash: `hash-${index.toString()}`,
    sessionGeneration: session.generation,
    sessionId: session.id,
    status: "DELIVERED",
    targetExecutionId: "execution-active",
    type: "input",
  };
  store.saveAction(action);
  store.bindIdempotency(`${session.id}:${actor.id}`, action.idempotencyKey, action.id);
  return action;
}

function saveControl(store: MemoryRuntimeStore, session: Session, index: number): ControlAction {
  const action: ControlAction = {
    acceptedAt: "2026-09-05T00:00:00.000Z",
    actionSequence: index,
    actor,
    bypassGuard: false,
    delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
    id: `action-${index.toString()}`,
    idempotencyKey: `key-${index.toString()}`,
    requestHash: `hash-${index.toString()}`,
    sessionGeneration: session.generation,
    sessionId: session.id,
    status: "DELIVERED",
    targetExecutionId: "execution-active",
    type: "control",
  };
  store.saveAction(action);
  store.bindIdempotency(`${session.id}:${actor.id}`, action.idempotencyKey, action.id);
  return action;
}
