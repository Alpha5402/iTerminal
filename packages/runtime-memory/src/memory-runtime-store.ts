import type {
  RuntimeEventRetention,
  RuntimeRetentionSnapshot,
  RuntimeStore,
  RuntimeStoreRetentionConfiguration,
} from "@iterminal/application";
import type { Execution, Session, SessionAction, SessionEvent } from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";

export class MemoryRuntimeStore implements RuntimeStore {
  readonly #sessions = new Map<string, Session>();
  readonly #actions = new Map<string, SessionAction>();
  readonly #executions = new Map<string, Execution>();
  readonly #events = new Map<string, EventBuffer>();
  readonly #idempotency = new Map<string, string>();
  readonly #idempotencyByAction = new Map<string, string>();
  readonly #actionBytes = new Map<string, number>();
  readonly #executionBytes = new Map<string, number>();
  readonly #durableHistory = new Map<string, HistoricalFact>();
  #durableHistoryBytes = 0;
  #actionBytesTotal = 0;
  #executionBytesTotal = 0;
  #configuration: RuntimeStoreRetentionConfiguration | undefined;

  public configureRetention(configuration: RuntimeStoreRetentionConfiguration): void {
    validateConfiguration(configuration);
    this.#configuration = configuration;
    this.#pruneDurableHistory();
    for (const buffer of this.#events.values()) this.#pruneEvents(buffer);
  }

  public createSession(session: Session): void {
    if (this.#sessions.has(session.id)) {
      throw new RuntimeError("INVALID_REQUEST", `Duplicate session: ${session.id}`);
    }
    this.#sessions.set(session.id, session);
    this.#events.set(eventScope(session.id, session.generation), emptyEventBuffer());
  }

  public deleteSession(sessionId: string, generation: number): void {
    const session = this.#generation(sessionId, generation);
    if (session.status !== "STARTING") {
      throw new RuntimeError(
        "INVALID_REQUEST",
        "Only an unadmitted STARTING Session can be removed from live memory",
        { sessionId, status: session.status },
      );
    }
    this.#sessions.delete(sessionId);
    this.#events.delete(eventScope(sessionId, generation));
  }

  public getSession(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  public listSessions(): readonly Session[] {
    return [...this.#sessions.values()];
  }

  public markSessionReady(sessionId: string, generation: number): Session {
    const session = this.#generation(sessionId, generation);
    if (session.status !== "STARTING") {
      throw stateError(session, "STARTING");
    }
    session.status = "READY";
    return session;
  }

  public reserveSession(sessionId: string, generation: number, executionId: string): Session {
    const session = this.#generation(sessionId, generation);
    if (session.status !== "READY") {
      if (session.status === "RESERVED" || session.status === "RUNNING") {
        throw new RuntimeError(
          "PTY_BUSY",
          "Session already has an active ExecuteAction",
          {
            activeExecutionId: session.activeExecutionId,
            availableActions: ["wait", "send_input", "control", "fork_session"],
            sessionId,
          },
          true,
        );
      }
      if (session.status === "BROKEN") {
        throw new RuntimeError("SESSION_BROKEN", "Cannot reserve a broken Session", { sessionId });
      }
      throw new RuntimeError(
        "SESSION_NOT_READY",
        `Cannot reserve Session in ${session.status}`,
        { sessionId, status: session.status },
        session.status === "STARTING",
      );
    }
    session.activeExecutionId = executionId;
    session.status = "RESERVED";
    return session;
  }

  public cancelReservation(sessionId: string, generation: number, executionId: string): Session {
    const session = this.#generation(sessionId, generation);
    this.#active(session, executionId);
    if (session.status !== "RESERVED") {
      throw stateError(session, "RESERVED");
    }
    delete session.activeExecutionId;
    session.status = "READY";
    return session;
  }

  public markSessionRunning(sessionId: string, generation: number, executionId: string): Session {
    const session = this.#generation(sessionId, generation);
    this.#active(session, executionId);
    if (session.status !== "RESERVED") {
      throw stateError(session, "RESERVED");
    }
    session.status = "RUNNING";
    return session;
  }

  public releaseSession(sessionId: string, generation: number, executionId: string): Session {
    const session = this.#generation(sessionId, generation);
    this.#active(session, executionId);
    if (session.status !== "RUNNING" && session.status !== "RESERVED") {
      throw stateError(session, "RUNNING or RESERVED");
    }
    delete session.activeExecutionId;
    session.status = "READY";
    return session;
  }

  public breakSession(sessionId: string, generation: number): Session {
    const session = this.#generation(sessionId, generation);
    if (session.status !== "CLOSED") {
      session.status = "BROKEN";
    }
    return session;
  }

  public closeSession(sessionId: string, generation: number): Session {
    const session = this.#generation(sessionId, generation);
    session.status = "CLOSED";
    session.closedAt = new Date().toISOString();
    delete session.activeExecutionId;
    return session;
  }

  public bumpScreenVersion(sessionId: string, generation: number): number {
    const session = this.#generation(sessionId, generation);
    session.screenVersion += 1;
    return session.screenVersion;
  }

  public nextActionSequence(sessionId: string, generation: number): number {
    const session = this.#generation(sessionId, generation);
    session.actionSequence += 1;
    return session.actionSequence;
  }

  public rollbackActionSequence(
    sessionId: string,
    generation: number,
    actionSequence: number,
  ): void {
    const session = this.#generation(sessionId, generation);
    if (session.actionSequence !== actionSequence) {
      throw new RuntimeError("INVALID_REQUEST", "Cannot roll back a non-current action sequence", {
        actionSequence,
        currentActionSequence: session.actionSequence,
        sessionId,
      });
    }
    session.actionSequence -= 1;
  }

  public saveAction(action: SessionAction): void {
    const previousBytes = this.#actionBytes.get(action.id) ?? 0;
    const nextBytes = estimatedBytes(action);
    this.#actions.set(action.id, action);
    this.#actionBytes.set(action.id, nextBytes);
    this.#actionBytesTotal += nextBytes - previousBytes;
    const historical = this.#durableHistory.get(action.id);
    if (historical !== undefined) {
      this.#durableHistoryBytes += nextBytes - previousBytes;
      historical.bytes += nextBytes - previousBytes;
    }
  }

  public getActionByIdempotency(scope: string, idempotencyKey: string): SessionAction | undefined {
    const actionId = this.#idempotency.get(idempotencyScope(scope, idempotencyKey));
    return actionId === undefined ? undefined : this.#actions.get(actionId);
  }

  public bindIdempotency(scope: string, idempotencyKey: string, actionId: string): void {
    const key = idempotencyScope(scope, idempotencyKey);
    this.#idempotency.set(key, actionId);
    this.#idempotencyByAction.set(actionId, key);
  }

  public getAction(actionId: string): SessionAction | undefined {
    return this.#actions.get(actionId);
  }

  public saveExecution(execution: Execution): void {
    const previousBytes = this.#executionBytes.get(execution.id) ?? 0;
    const nextBytes = estimatedBytes(execution);
    this.#executions.set(execution.id, execution);
    this.#executionBytes.set(execution.id, nextBytes);
    this.#executionBytesTotal += nextBytes - previousBytes;
    const historical = this.#durableHistory.get(execution.actionId);
    if (historical !== undefined && historical.executionId === execution.id) {
      this.#durableHistoryBytes += nextBytes - previousBytes;
      historical.bytes += nextBytes - previousBytes;
    }
  }

  public getExecution(executionId: string): Execution | undefined {
    return this.#executions.get(executionId);
  }

  public appendEvent(
    sessionId: string,
    generation: number,
    event: Omit<SessionEvent, "sequence">,
  ): SessionEvent {
    const session = this.#generation(sessionId, generation);
    session.eventSequence += 1;
    const stored: SessionEvent = {
      ...event,
      sequence: session.eventSequence,
    };
    const events = this.#events.get(eventScope(sessionId, generation));
    if (events === undefined) {
      throw new RuntimeError("INVALID_REQUEST", "Missing event stream", { generation, sessionId });
    }
    events.events.push(stored);
    events.bytes += estimatedBytes(stored);
    this.#pruneEvents(events);
    return stored;
  }

  public queryEvents(
    sessionId: string,
    generation: number,
    after: number,
    limit: number,
  ): readonly SessionEvent[] {
    this.#generation(sessionId, generation);
    const buffer = this.#events.get(eventScope(sessionId, generation));
    if (buffer === undefined) return [];
    const result: SessionEvent[] = [];
    for (
      let index = buffer.start;
      index < buffer.events.length && result.length < limit;
      index += 1
    ) {
      const event = buffer.events[index];
      if (event !== undefined && event.sequence > after) result.push(event);
    }
    return result;
  }

  public assertActionCapacity(
    actionType: SessionAction["type"],
    estimatedActionBytes: number,
  ): void {
    const configuration = this.#configuration;
    if (configuration === undefined || configuration.durable) return;
    if (!Number.isSafeInteger(estimatedActionBytes) || estimatedActionBytes < 1) {
      throw new RuntimeError("INVALID_REQUEST", "Action memory estimate must be positive", {
        estimatedActionBytes,
      });
    }
    const { limits } = configuration;
    const control = actionType === "control";
    const maxEntries = control
      ? limits.memoryOnlyActionEntries
      : limits.memoryOnlyActionEntries - limits.memoryOnlyControlReserveEntries;
    const maxBytes = control
      ? limits.memoryOnlyActionBytes
      : limits.memoryOnlyActionBytes - limits.memoryOnlyControlReserveBytes;
    if (
      this.#actions.size + 1 > maxEntries ||
      this.#actionBytesTotal + this.#executionBytesTotal + estimatedActionBytes > maxBytes
    ) {
      throw new RuntimeError(
        "BACKPRESSURE",
        "Memory-only Action history capacity is exhausted",
        {
          component: "runtime_memory_history",
          currentHistoryBytes: this.#actionBytesTotal + this.#executionBytesTotal,
          currentActionEntries: this.#actions.size,
          maxActionBytes: maxBytes,
          maxActionEntries: maxEntries,
          reserve: control ? "control" : "ordinary",
        },
        false,
      );
    }
  }

  public settleActionHistory(actionId: string, executionId?: string): void {
    const action = this.#actions.get(actionId);
    if (action === undefined || !isTerminalActionStatus(action.status)) return;
    const execution = executionId === undefined ? undefined : this.#executions.get(executionId);
    if (
      executionId !== undefined &&
      (execution === undefined || !isTerminalExecutionStatus(execution.status))
    ) {
      return;
    }
    this.#refreshBytes(action, execution);
    const configuration = this.#configuration;
    if (configuration === undefined || !configuration.durable) return;
    const bytes =
      (this.#actionBytes.get(actionId) ?? 0) +
      (executionId === undefined ? 0 : (this.#executionBytes.get(executionId) ?? 0));
    const existing = this.#durableHistory.get(actionId);
    if (existing !== undefined) {
      this.#durableHistoryBytes += bytes - existing.bytes;
      existing.bytes = bytes;
      this.#pruneDurableHistory();
      return;
    }
    this.#durableHistory.set(actionId, {
      bytes,
      ...(executionId === undefined ? {} : { executionId }),
    });
    this.#durableHistoryBytes += bytes;
    this.#pruneDurableHistory();
  }

  public eventRetention(sessionId: string, generation: number): RuntimeEventRetention {
    this.#generation(sessionId, generation);
    const buffer = this.#events.get(eventScope(sessionId, generation));
    const discardedThrough = buffer?.discardedThrough ?? 0;
    return {
      discardedThrough,
      minimumAvailableSequence: discardedThrough + 1,
    };
  }

  public retentionSnapshot(): RuntimeRetentionSnapshot {
    let events = 0;
    let eventBytes = 0;
    for (const buffer of this.#events.values()) {
      events += retainedEventCount(buffer);
      eventBytes += buffer.bytes;
    }
    return {
      actions: this.#actions.size,
      actionBytes: this.#actionBytesTotal,
      durableHistoryBytes: this.#durableHistoryBytes,
      durableHistoryEntries: this.#durableHistory.size,
      events,
      eventBytes,
      executions: this.#executions.size,
      executionBytes: this.#executionBytesTotal,
      historyBytes: this.#actionBytesTotal + this.#executionBytesTotal,
      idempotencyBindings: this.#idempotency.size,
    };
  }

  #refreshBytes(action: SessionAction, execution: Execution | undefined): void {
    const previousActionBytes = this.#actionBytes.get(action.id) ?? 0;
    const nextActionBytes = estimatedBytes(action);
    this.#actionBytes.set(action.id, nextActionBytes);
    this.#actionBytesTotal += nextActionBytes - previousActionBytes;
    if (execution !== undefined) {
      const previousExecutionBytes = this.#executionBytes.get(execution.id) ?? 0;
      const nextExecutionBytes = estimatedBytes(execution);
      this.#executionBytes.set(execution.id, nextExecutionBytes);
      this.#executionBytesTotal += nextExecutionBytes - previousExecutionBytes;
    }
  }

  #pruneDurableHistory(): void {
    const configuration = this.#configuration;
    if (configuration === undefined || !configuration.durable) return;
    while (
      this.#durableHistory.size > configuration.limits.durableHistoryEntries ||
      this.#durableHistoryBytes > configuration.limits.durableHistoryBytes
    ) {
      const oldest = this.#durableHistory.entries().next().value;
      if (oldest === undefined) return;
      const [actionId, fact] = oldest;
      this.#durableHistory.delete(actionId);
      this.#durableHistoryBytes -= fact.bytes;
      this.#actions.delete(actionId);
      const actionBytes = this.#actionBytes.get(actionId) ?? 0;
      this.#actionBytes.delete(actionId);
      this.#actionBytesTotal -= actionBytes;
      const idempotencyKey = this.#idempotencyByAction.get(actionId);
      if (idempotencyKey !== undefined) this.#idempotency.delete(idempotencyKey);
      this.#idempotencyByAction.delete(actionId);
      if (fact.executionId !== undefined) {
        this.#executions.delete(fact.executionId);
        const executionBytes = this.#executionBytes.get(fact.executionId) ?? 0;
        this.#executionBytes.delete(fact.executionId);
        this.#executionBytesTotal -= executionBytes;
      }
    }
  }

  #pruneEvents(buffer: EventBuffer): void {
    const limits = this.#configuration?.limits;
    if (limits === undefined) return;
    while (
      retainedEventCount(buffer) > 0 &&
      (retainedEventCount(buffer) > limits.eventEntriesPerGeneration ||
        buffer.bytes > limits.eventBytesPerGeneration)
    ) {
      const event = buffer.events[buffer.start];
      if (event === undefined) return;
      buffer.events[buffer.start] = undefined;
      buffer.start += 1;
      buffer.bytes -= estimatedBytes(event);
      buffer.discardedThrough = event.sequence;
    }
    if (buffer.start > 1_024 && buffer.start * 2 > buffer.events.length) {
      buffer.events = buffer.events.slice(buffer.start);
      buffer.start = 0;
    }
  }

  #generation(sessionId: string, generation: number): Session {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new RuntimeError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`, { sessionId });
    }
    if (session.generation !== generation) {
      throw new RuntimeError("SESSION_GENERATION_CHANGED", "Session generation changed", {
        currentGeneration: session.generation,
        sessionId,
      });
    }
    return session;
  }

  #active(session: Session, executionId: string): void {
    if (session.activeExecutionId !== executionId) {
      throw new RuntimeError("EXECUTION_CHANGED", "Active execution changed", {
        activeExecutionId: session.activeExecutionId,
        executionId,
      });
    }
  }
}

interface EventBuffer {
  bytes: number;
  discardedThrough: number;
  events: Array<SessionEvent | undefined>;
  start: number;
}

interface HistoricalFact {
  bytes: number;
  executionId?: string;
}

function emptyEventBuffer(): EventBuffer {
  return { bytes: 0, discardedThrough: 0, events: [], start: 0 };
}

function retainedEventCount(buffer: EventBuffer): number {
  return buffer.events.length - buffer.start;
}

function estimatedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isTerminalActionStatus(status: SessionAction["status"]): boolean {
  return (
    status === "DELIVERED" ||
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "INTERRUPTED" ||
    status === "UNKNOWN"
  );
}

function isTerminalExecutionStatus(status: Execution["status"]): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "INTERRUPTED" ||
    status === "UNKNOWN"
  );
}

function validateConfiguration(configuration: RuntimeStoreRetentionConfiguration): void {
  for (const [name, value] of Object.entries(configuration.limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RuntimeError("INVALID_REQUEST", `Runtime retention ${name} must be positive`, {
        name,
        value,
      });
    }
  }
  const { limits } = configuration;
  if (
    limits.memoryOnlyControlReserveEntries >= limits.memoryOnlyActionEntries ||
    limits.memoryOnlyControlReserveBytes >= limits.memoryOnlyActionBytes
  ) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Memory-only Control reserve must be smaller than total Action capacity",
    );
  }
}

function eventScope(sessionId: string, generation: number): string {
  return `${sessionId}:${generation.toString()}`;
}

function idempotencyScope(scope: string, key: string): string {
  return `${scope}:${key}`;
}

function stateError(session: Session, expected: string): RuntimeError {
  return new RuntimeError("SESSION_NOT_READY", `Expected ${expected}, received ${session.status}`, {
    sessionId: session.id,
    status: session.status,
  });
}
