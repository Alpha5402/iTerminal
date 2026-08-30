import type { RuntimeStore } from "@iterminal/application";
import type { Execution, Session, SessionAction, SessionEvent } from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";

export class MemoryRuntimeStore implements RuntimeStore {
  readonly #sessions = new Map<string, Session>();
  readonly #actions = new Map<string, SessionAction>();
  readonly #executions = new Map<string, Execution>();
  readonly #events = new Map<string, SessionEvent[]>();
  readonly #idempotency = new Map<string, string>();

  public createSession(session: Session): void {
    if (this.#sessions.has(session.id)) {
      throw new RuntimeError("INVALID_REQUEST", `Duplicate session: ${session.id}`);
    }
    this.#sessions.set(session.id, session);
    this.#events.set(eventScope(session.id, session.generation), []);
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
    this.#actions.set(action.id, action);
  }

  public getActionByIdempotency(scope: string, idempotencyKey: string): SessionAction | undefined {
    const actionId = this.#idempotency.get(idempotencyScope(scope, idempotencyKey));
    return actionId === undefined ? undefined : this.#actions.get(actionId);
  }

  public bindIdempotency(scope: string, idempotencyKey: string, actionId: string): void {
    this.#idempotency.set(idempotencyScope(scope, idempotencyKey), actionId);
  }

  public getAction(actionId: string): SessionAction | undefined {
    return this.#actions.get(actionId);
  }

  public saveExecution(execution: Execution): void {
    this.#executions.set(execution.id, execution);
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
    events.push(stored);
    return stored;
  }

  public queryEvents(
    sessionId: string,
    generation: number,
    after: number,
    limit: number,
  ): readonly SessionEvent[] {
    this.#generation(sessionId, generation);
    return (this.#events.get(eventScope(sessionId, generation)) ?? [])
      .filter((event) => event.sequence > after)
      .slice(0, limit);
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
