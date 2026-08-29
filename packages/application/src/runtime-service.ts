import { createHash, randomUUID } from "node:crypto";

import type {
  Actor,
  ControlAction,
  ControlDelivery,
  EventPage,
  ExecuteAction,
  Execution,
  InputAction,
  Session,
  SessionAction,
  SessionEvent,
  ShellKind,
} from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";

import type {
  DurableSessionEvent,
  RuntimeDurability,
  RuntimeServiceOptions,
  RuntimeStore,
  ShellExecutor,
  ShellExecutorFactory,
} from "./ports.js";

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;
const MAX_PENDING_DURABLE_EVENTS = 10_000;
const MAX_PENDING_DURABLE_BYTES = 8 * 1024 * 1024;
const DURABLE_FLUSH_TIMEOUT_MS = 30_000;

export interface CreateSessionRequest {
  readonly shell: ShellKind;
  readonly workspaceRoot: string;
}

export interface ExecuteRequest {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly actor: Actor;
  readonly command: string;
  readonly idempotencyKey: string;
}

export interface InputRequest {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly actor: Actor;
  readonly targetExecutionId: string;
  readonly data: string;
  readonly expectedScreenVersion?: number;
  readonly idempotencyKey: string;
}

export interface ControlRequest {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly actor: Actor;
  readonly targetExecutionId: string;
  readonly delivery: ControlDelivery;
  readonly idempotencyKey: string;
}

export interface StartedExecution {
  readonly action: ExecuteAction;
  readonly execution: Execution;
  readonly started: Promise<void>;
  readonly completion: Promise<Execution>;
}

interface EventOptions {
  readonly action?: SessionAction;
  readonly execution?: Execution;
  readonly persist?: boolean;
}

interface DurableQueueState {
  failure?: RuntimeError;
  pendingBytes: number;
  pendingEvents: number;
  tail: Promise<void>;
}

export class RuntimeService {
  readonly #executors = new Map<string, ShellExecutor>();
  readonly #completions = new Map<string, Promise<Execution>>();
  readonly #started = new Map<string, Promise<void>>();
  readonly #durableQueues = new Map<string, DurableQueueState>();
  readonly #mutationTails = new Map<string, Promise<void>>();
  readonly #durability: RuntimeDurability | undefined;
  readonly #now: () => Date;
  readonly #ownerId: string;

  public constructor(
    private readonly store: RuntimeStore,
    private readonly executorFactory: ShellExecutorFactory,
    options: RuntimeServiceOptions = {},
  ) {
    this.#durability = options.durability;
    this.#now = options.now ?? (() => new Date());
    this.#ownerId = options.ownerId ?? `owner_${process.pid.toString()}`;
  }

  public async createSession(request: CreateSessionRequest): Promise<Session> {
    const sessionId = `ses_${randomUUID()}`;
    const generation = 1;
    const createdAt = this.#timestamp();
    const session: Session = {
      actionSequence: 0,
      createdAt,
      eventSequence: 0,
      generation,
      id: sessionId,
      ownerId: this.#ownerId,
      screenVersion: 0,
      shell: request.shell,
      status: "STARTING",
      workspaceRoot: request.workspaceRoot,
    };
    this.store.createSession(session);
    const createdEvent = this.#event(
      session,
      "session.created",
      { shell: request.shell },
      {
        persist: false,
      },
    );
    const startingEvent = this.#event(session, "session.shell_starting", {}, { persist: false });

    try {
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.createSession(session, [createdEvent, startingEvent]),
      );
    } catch (error) {
      this.store.breakSession(sessionId, generation);
      throw durabilityError(error);
    }

    try {
      const executor = await this.executorFactory.create({
        onOutput: (data) => this.#recordOutput(sessionId, generation, data),
        shell: request.shell,
        workspaceRoot: request.workspaceRoot,
      });
      this.#executors.set(sessionId, executor);
      const ready = this.store.markSessionReady(sessionId, generation);
      const readyEvent = this.#event(
        ready,
        "session.shell_ready",
        { shellPid: executor.shellPid },
        { persist: false },
      );
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.markSessionReady(ready, executor.shellPid, readyEvent),
      );
      return ready;
    } catch (error) {
      this.#executors.get(sessionId)?.close();
      this.#executors.delete(sessionId);
      const broken = this.store.breakSession(sessionId, generation);
      const brokenEvent = this.#event(
        broken,
        "session.broken",
        { reason: errorMessage(error) },
        { persist: false },
      );
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.markSessionBroken(broken, [brokenEvent], errorMessage(error)),
      ).catch(() => undefined);
      throw error;
    }
  }

  public getSession(sessionId: string): Session {
    return this.#requireSession(sessionId);
  }

  public listSessions(): readonly Session[] {
    return this.store.listSessions();
  }

  public async recoverDurableOwner(reason: string): Promise<{
    readonly brokenSessions: number;
    readonly unknownExecutions: number;
  }> {
    return (
      (await this.#durability?.recoverOwner(this.#ownerId, reason)) ?? {
        brokenSessions: 0,
        unknownExecutions: 0,
      }
    );
  }

  public startExecute(request: ExecuteRequest): Promise<StartedExecution> {
    return this.#withMutationLock(request.sessionId, () => this.#startExecuteLocked(request));
  }

  async #startExecuteLocked(request: ExecuteRequest): Promise<StartedExecution> {
    if (request.command.includes("\0")) {
      throw new RuntimeError("INVALID_REQUEST", "Execute command cannot contain NUL bytes");
    }
    await this.#flushDurable(request.sessionId);
    const requestHash = hashRequest({ command: request.command });
    const scope = `${request.sessionId}:${request.actor.id}`;
    const replay = this.#idempotentReplay(scope, request.idempotencyKey, requestHash);
    if (replay !== undefined) {
      if (replay.type !== "execute") {
        throw new RuntimeError("IDEMPOTENCY_KEY_REUSED", "Idempotency key changed action type");
      }
      const execution = this.#requireExecution(replay.executionId);
      return {
        action: replay,
        completion: this.#completions.get(execution.id) ?? Promise.resolve(execution),
        execution,
        started: this.#started.get(execution.id) ?? Promise.resolve(),
      };
    }

    const session = this.#requireGeneration(request.sessionId, request.sessionGeneration);
    const executor = this.#requireExecutor(session.id);
    const actionId = `act_${randomUUID()}`;
    const executionId = `exe_${randomUUID()}`;
    const reserved = this.store.reserveSession(session.id, session.generation, executionId);
    const acceptedAt = this.#timestamp();
    const actionSequence = this.store.nextActionSequence(session.id, session.generation);
    const action: ExecuteAction = {
      acceptedAt,
      actionSequence,
      actor: request.actor,
      command: request.command,
      executionId,
      id: actionId,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      sessionGeneration: session.generation,
      sessionId: session.id,
      status: "DISPATCHING",
      type: "execute",
    };
    const execution: Execution = {
      actionId,
      actor: request.actor,
      command: request.command,
      createdAt: acceptedAt,
      id: executionId,
      sessionGeneration: session.generation,
      sessionId: session.id,
      status: "DISPATCHING",
    };
    const acceptedEvent = this.#eventDraft(reserved, "action.accepted", {}, action, execution);
    const dispatchingEvent = this.#eventDraft(
      reserved,
      "action.dispatching",
      {},
      action,
      execution,
    );
    try {
      if (this.#durability !== undefined) {
        const durable = await this.#enqueueDurable(session.id, 0, () =>
          this.#durability?.acceptExecute({
            acceptedEvent,
            action,
            dispatchingEvent,
            execution,
          }),
        );
        if (
          durable === undefined ||
          durable.replayed ||
          durable.actionId !== action.id ||
          durable.executionId !== execution.id ||
          durable.actionSequence !== action.actionSequence
        ) {
          throw new RuntimeError(
            "DELIVERY_UNKNOWN",
            "Durable Execute admission does not match the live Runtime projection",
            { durable, expectedActionId: action.id, expectedExecutionId: execution.id },
          );
        }
      }
    } catch (error) {
      this.store.rollbackActionSequence(session.id, session.generation, actionSequence);
      this.store.cancelReservation(session.id, session.generation, executionId);
      if (isDurabilityFatal(error)) {
        this.#tripDurability(session.id, error);
      }
      throw error instanceof RuntimeError ? error : durabilityError(error);
    }
    this.store.saveAction(action);
    this.store.bindIdempotency(scope, request.idempotencyKey, action.id);
    this.store.saveExecution(execution);
    this.store.appendEvent(session.id, session.generation, acceptedEvent);
    this.store.appendEvent(session.id, session.generation, dispatchingEvent);

    const startedDeferred = deferred<void>();
    void startedDeferred.promise.catch(() => undefined);
    this.#started.set(execution.id, startedDeferred.promise);
    const completion = executor
      .execute(request.command, {
        onStarted: (observedCommand) => {
          execution.status = "RUNNING";
          execution.startedAt = this.#timestamp();
          action.status = "RUNNING";
          const running = this.store.markSessionRunning(
            session.id,
            session.generation,
            execution.id,
          );
          const startedEvent = this.#event(
            running,
            "execution.started",
            { observedCommand },
            { action, execution, persist: false },
          );
          void this.#enqueueDurable(session.id, 0, () =>
            this.#durability?.markExecutionRunning({
              action,
              event: startedEvent,
              execution,
              session: running,
            }),
          ).catch((error: unknown) => this.#tripDurability(session.id, error));
          startedDeferred.resolve();
        },
      })
      .then(async (result) => {
        execution.exitCode = result.exitCode;
        execution.cwd = result.cwd;
        execution.finishedAt = this.#timestamp();
        execution.output = result.output;
        execution.outputTruncated = result.outputTruncated;
        const interrupted = execution.interruptedRequested === true && result.exitCode !== 0;
        execution.status = interrupted ? "INTERRUPTED" : "COMPLETED";
        action.status = interrupted ? "INTERRUPTED" : "COMPLETED";
        const ready = this.store.releaseSession(session.id, session.generation, execution.id);
        const completedEvent = this.#event(
          ready,
          interrupted ? "execution.interrupted" : "execution.completed",
          { cwd: result.cwd, exitCode: result.exitCode, outputTruncated: result.outputTruncated },
          { action, execution, persist: false },
        );
        const readyEvent = this.#event(
          ready,
          "session.shell_ready",
          { cwd: result.cwd },
          { persist: false },
        );
        try {
          await this.#enqueueDurable(session.id, 0, () =>
            this.#durability?.finishExecution({
              action,
              events: [completedEvent, readyEvent],
              execution,
              session: ready,
            }),
          );
        } catch (error) {
          execution.status = "UNKNOWN";
          action.status = "UNKNOWN";
          this.#tripDurability(session.id, error);
          throw durabilityError(error);
        }
        return execution;
      })
      .catch(async (error: unknown) => {
        if (execution.status === "UNKNOWN") {
          throw error;
        }
        startedDeferred.reject(error);
        execution.status = "FAILED";
        execution.finishedAt = this.#timestamp();
        action.status = "FAILED";
        const current = this.store.getSession(session.id);
        if (current?.status !== "CLOSED") {
          const broken = this.store.breakSession(session.id, session.generation);
          const failedEvent = this.#event(
            broken,
            "execution.failed",
            { reason: errorMessage(error) },
            { action, execution, persist: false },
          );
          const brokenEvent = this.#event(
            broken,
            "session.broken",
            { reason: errorMessage(error) },
            { persist: false },
          );
          await this.#enqueueDurable(session.id, 0, () =>
            this.#durability?.failExecution({
              action,
              events: [failedEvent, brokenEvent],
              execution,
              reason: errorMessage(error),
              session: broken,
            }),
          ).catch((durableError: unknown) => this.#tripDurability(session.id, durableError));
        }
        throw error;
      });
    void completion.catch(() => undefined);
    this.#completions.set(execution.id, completion);
    return { action, completion, execution, started: startedDeferred.promise };
  }

  public async execute(request: ExecuteRequest): Promise<Execution> {
    return (await this.startExecute(request)).completion;
  }

  public sendInput(request: InputRequest): Promise<InputAction> {
    return this.#withMutationLock(request.sessionId, () => this.#sendInputLocked(request));
  }

  async #sendInputLocked(request: InputRequest): Promise<InputAction> {
    if (request.data.includes("\0")) {
      throw new RuntimeError("INVALID_REQUEST", "Input data cannot contain NUL bytes");
    }
    await this.#flushDurable(request.sessionId);
    const requestHash = hashRequest({
      data: request.data,
      expectedScreenVersion: request.expectedScreenVersion,
      targetExecutionId: request.targetExecutionId,
    });
    const scope = `${request.sessionId}:${request.actor.id}`;
    const replay = this.#idempotentReplay(scope, request.idempotencyKey, requestHash);
    if (replay !== undefined) {
      if (replay.type !== "input") {
        throw new RuntimeError("IDEMPOTENCY_KEY_REUSED", "Idempotency key changed action type");
      }
      return replay;
    }
    const session = this.#requireInteractionTarget(
      request.sessionId,
      request.sessionGeneration,
      request.targetExecutionId,
      request.expectedScreenVersion,
    );
    const action: InputAction = {
      acceptedAt: this.#timestamp(),
      actionSequence: this.store.nextActionSequence(session.id, session.generation),
      actor: request.actor,
      data: request.data,
      id: `act_${randomUUID()}`,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      sessionGeneration: session.generation,
      sessionId: session.id,
      status: "ACCEPTED",
      targetExecutionId: request.targetExecutionId,
      type: "input",
      ...(request.expectedScreenVersion === undefined
        ? {}
        : { expectedScreenVersion: request.expectedScreenVersion }),
    };
    const acceptedEvent = this.#eventDraft(session, "action.accepted", {}, action);
    try {
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.acceptInteraction(action, acceptedEvent),
      );
    } catch (error) {
      this.store.rollbackActionSequence(session.id, session.generation, action.actionSequence);
      if (isDurabilityFatal(error)) this.#tripDurability(session.id, error);
      throw error instanceof RuntimeError ? error : durabilityError(error);
    }
    this.store.saveAction(action);
    this.store.bindIdempotency(scope, request.idempotencyKey, action.id);
    this.store.appendEvent(session.id, session.generation, acceptedEvent);
    try {
      this.#requireExecutor(session.id).writeInput(request.data);
      action.status = "DELIVERED";
      const deliveredEvent = this.#event(
        session,
        "interaction.input_delivered",
        { byteLength: byteLength(request.data) },
        { action, persist: false },
      );
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.finishInteraction(action, deliveredEvent),
      );
      return action;
    } catch (error) {
      action.status = "UNKNOWN";
      const unknownEvent = this.#event(
        session,
        "interaction.input_unknown",
        { reason: errorMessage(error) },
        { action, persist: false },
      );
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.finishInteraction(action, unknownEvent),
      ).catch((durableFailure: unknown) => this.#tripDurability(session.id, durableFailure));
      throw new RuntimeError(
        "DELIVERY_UNKNOWN",
        "PTY input delivery is uncertain",
        { actionId: action.id },
        false,
      );
    }
  }

  public sendControl(request: ControlRequest): Promise<ControlAction> {
    return this.#withMutationLock(request.sessionId, () => this.#sendControlLocked(request));
  }

  async #sendControlLocked(request: ControlRequest): Promise<ControlAction> {
    await this.#flushDurable(request.sessionId);
    const requestHash = hashRequest({
      delivery: request.delivery,
      targetExecutionId: request.targetExecutionId,
    });
    const scope = `${request.sessionId}:${request.actor.id}`;
    const replay = this.#idempotentReplay(scope, request.idempotencyKey, requestHash);
    if (replay !== undefined) {
      if (replay.type !== "control") {
        throw new RuntimeError("IDEMPOTENCY_KEY_REUSED", "Idempotency key changed action type");
      }
      return replay;
    }
    const session = this.#requireInteractionTarget(
      request.sessionId,
      request.sessionGeneration,
      request.targetExecutionId,
    );
    const action: ControlAction = {
      acceptedAt: this.#timestamp(),
      actionSequence: this.store.nextActionSequence(session.id, session.generation),
      actor: request.actor,
      delivery: request.delivery,
      id: `act_${randomUUID()}`,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      sessionGeneration: session.generation,
      sessionId: session.id,
      status: "ACCEPTED",
      targetExecutionId: request.targetExecutionId,
      type: "control",
    };
    const acceptedEvent = this.#eventDraft(session, "action.accepted", {}, action);
    try {
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.acceptInteraction(action, acceptedEvent),
      );
    } catch (error) {
      this.store.rollbackActionSequence(session.id, session.generation, action.actionSequence);
      if (isDurabilityFatal(error)) this.#tripDurability(session.id, error);
      throw error instanceof RuntimeError ? error : durabilityError(error);
    }
    this.store.saveAction(action);
    this.store.bindIdempotency(scope, request.idempotencyKey, action.id);
    this.store.appendEvent(session.id, session.generation, acceptedEvent);
    try {
      this.#requireExecutor(session.id).sendControl(request.delivery);
      const execution = this.#requireExecution(request.targetExecutionId);
      execution.interruptedRequested = isInterrupt(request.delivery);
      action.status = "DELIVERED";
      const deliveredEvent = this.#event(
        session,
        "interaction.control_delivered",
        { delivery: request.delivery },
        { action, persist: false },
      );
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.finishInteraction(action, deliveredEvent),
      );
      return action;
    } catch (error) {
      action.status = "UNKNOWN";
      const unknownEvent = this.#event(
        session,
        "interaction.control_unknown",
        { reason: errorMessage(error) },
        { action, persist: false },
      );
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.finishInteraction(action, unknownEvent),
      ).catch((durableFailure: unknown) => this.#tripDurability(session.id, durableFailure));
      throw new RuntimeError(
        "DELIVERY_UNKNOWN",
        "Control delivery is uncertain",
        { actionId: action.id },
        false,
      );
    }
  }

  public getExecution(executionId: string): Execution {
    return this.#requireExecution(executionId);
  }

  public async waitExecution(executionId: string): Promise<Execution> {
    const execution = this.#requireExecution(executionId);
    return this.#completions.get(execution.id) ?? execution;
  }

  public async queryEvents(
    sessionId: string,
    generation: number,
    after = 0,
    requestedLimit = DEFAULT_EVENT_LIMIT,
  ): Promise<EventPage> {
    this.#requireGeneration(sessionId, generation);
    const limit = Math.max(1, Math.min(requestedLimit, MAX_EVENT_LIMIT));
    if (this.#durability !== undefined) {
      await this.#flushDurable(sessionId);
      return this.#durability.queryEvents(sessionId, generation, after, limit);
    }
    const events = this.store.queryEvents(sessionId, generation, after, limit + 1);
    const truncated = events.length > limit;
    const page = truncated ? events.slice(0, limit) : events;
    const last = page.at(-1);
    return {
      events: page,
      truncated,
      ...(truncated && last !== undefined ? { nextAfter: last.sequence } : {}),
    };
  }

  public closeSession(sessionId: string, generation: number): Promise<Session> {
    return this.#withMutationLock(sessionId, async () => {
      let flushFailure: unknown;
      await this.#flushDurable(sessionId).catch((error: unknown) => {
        flushFailure = error;
      });
      const session = this.#requireExactGeneration(sessionId, generation);
      const previousStatus = session.status;
      this.#executors.get(sessionId)?.close();
      this.#executors.delete(sessionId);
      const closed = this.store.closeSession(sessionId, generation);
      const closedEvent = this.#event(
        closed,
        "session.closed",
        { previousStatus },
        { persist: false },
      );
      if (flushFailure !== undefined) throw durabilityError(flushFailure);
      await this.#enqueueDurable(sessionId, 0, () =>
        this.#durability?.closeSession(closed, closedEvent),
      );
      return closed;
    });
  }

  #recordOutput(sessionId: string, generation: number, data: string): void {
    const current = this.store.getSession(sessionId);
    if (current === undefined || current.generation !== generation || current.status === "CLOSED") {
      return;
    }
    const screenVersion = this.store.bumpScreenVersion(sessionId, generation);
    const execution =
      current.activeExecutionId === undefined
        ? undefined
        : this.store.getExecution(current.activeExecutionId);
    const action = execution === undefined ? undefined : this.store.getAction(execution.actionId);
    this.#event(
      current,
      "terminal.pty_output",
      {
        byteLength: byteLength(data),
        data,
        screenVersion,
      },
      {
        persist: true,
        ...(action === undefined ? {} : { action }),
        ...(execution === undefined ? {} : { execution }),
      },
    );
  }

  #requireSession(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (session === undefined) {
      throw new RuntimeError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`, { sessionId });
    }
    return session;
  }

  #requireGeneration(sessionId: string, generation: number): Session {
    const session = this.#requireExactGeneration(sessionId, generation);
    if (session.status === "BROKEN") {
      throw new RuntimeError("SESSION_BROKEN", `Session is broken: ${sessionId}`, { sessionId });
    }
    if (session.status === "CLOSED") {
      throw new RuntimeError("SESSION_NOT_READY", `Session is closed: ${sessionId}`, { sessionId });
    }
    return session;
  }

  #requireExactGeneration(sessionId: string, generation: number): Session {
    const session = this.#requireSession(sessionId);
    if (session.generation !== generation) {
      throw new RuntimeError(
        "SESSION_GENERATION_CHANGED",
        `Expected generation ${generation.toString()}, current ${session.generation.toString()}`,
        { currentGeneration: session.generation, sessionId },
      );
    }
    return session;
  }

  #requireInteractionTarget(
    sessionId: string,
    generation: number,
    targetExecutionId: string,
    expectedScreenVersion?: number,
  ): Session {
    const session = this.#requireGeneration(sessionId, generation);
    if (session.status !== "RUNNING" || session.activeExecutionId !== targetExecutionId) {
      throw new RuntimeError(
        "EXECUTION_CHANGED",
        "Interaction no longer targets the active execution",
        {
          activeExecutionId: session.activeExecutionId,
          targetExecutionId,
        },
      );
    }
    if (expectedScreenVersion !== undefined && expectedScreenVersion !== session.screenVersion) {
      throw new RuntimeError("SCREEN_CHANGED", "Expected screen version is stale", {
        currentScreenVersion: session.screenVersion,
        expectedScreenVersion,
      });
    }
    return session;
  }

  #requireExecutor(sessionId: string): ShellExecutor {
    const executor = this.#executors.get(sessionId);
    if (executor === undefined) {
      throw new RuntimeError("SESSION_NOT_READY", "Session has no live Executor", { sessionId });
    }
    return executor;
  }

  #requireExecution(executionId: string): Execution {
    const execution = this.store.getExecution(executionId);
    if (execution === undefined) {
      throw new RuntimeError("EXECUTION_NOT_FOUND", `Execution not found: ${executionId}`, {
        executionId,
      });
    }
    return execution;
  }

  #idempotentReplay(
    scope: string,
    idempotencyKey: string,
    requestHash: string,
  ): SessionAction | undefined {
    const action = this.store.getActionByIdempotency(scope, idempotencyKey);
    if (action !== undefined && action.requestHash !== requestHash) {
      throw new RuntimeError(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency key was already used with a different request",
        { actionId: action.id },
      );
    }
    return action;
  }

  #event(
    session: Session,
    type: string,
    payload: Readonly<Record<string, unknown>>,
    options: EventOptions = {},
  ): SessionEvent {
    const draft = this.#eventDraft(session, type, payload, options.action, options.execution);
    const stored = this.store.appendEvent(session.id, session.generation, draft);
    if (options.persist !== false && this.#durability !== undefined) {
      const pendingBytes =
        type === "terminal.pty_output" && typeof payload.data === "string"
          ? byteLength(payload.data)
          : 0;
      void this.#enqueueDurable(session.id, pendingBytes, () =>
        this.#durability?.appendEvent(draft),
      ).catch((error: unknown) => this.#tripDurability(session.id, error));
    }
    return stored;
  }

  #eventDraft(
    session: Session,
    type: string,
    payload: Readonly<Record<string, unknown>>,
    action?: SessionAction,
    execution?: Execution,
  ): DurableSessionEvent {
    return {
      id: `evt_${randomUUID()}`,
      observedAt: this.#timestamp(),
      payload,
      sessionGeneration: session.generation,
      sessionId: session.id,
      type,
      ...(action === undefined ? {} : { actionId: action.id, actor: action.actor }),
      ...(execution === undefined ? {} : { executionId: execution.id }),
    };
  }

  async #enqueueDurable<T>(
    sessionId: string,
    pendingBytes: number,
    work: () => Promise<T> | undefined,
  ): Promise<T | undefined> {
    if (this.#durability === undefined) return undefined;
    const state = this.#durableQueue(sessionId);
    if (state.failure !== undefined) throw state.failure;
    if (
      state.pendingEvents + 1 > MAX_PENDING_DURABLE_EVENTS ||
      state.pendingBytes + pendingBytes > MAX_PENDING_DURABLE_BYTES
    ) {
      const failure = new RuntimeError(
        "RUNTIME_UNAVAILABLE",
        "Durable event ingest backlog exceeded its bound",
        {
          maxPendingBytes: MAX_PENDING_DURABLE_BYTES,
          maxPendingEvents: MAX_PENDING_DURABLE_EVENTS,
          sessionId,
        },
        true,
      );
      state.failure = failure;
      throw failure;
    }
    state.pendingEvents += 1;
    state.pendingBytes += pendingBytes;
    const operation = state.tail.then(async () => {
      if (state.failure !== undefined) throw state.failure;
      try {
        return await work();
      } catch (error) {
        if (error instanceof RuntimeError) {
          if (error.code === "RUNTIME_UNAVAILABLE") state.failure ??= error;
          if (error.code === "DELIVERY_UNKNOWN") state.failure ??= durabilityError(error);
          throw error;
        }
        const failure = durabilityError(error);
        state.failure ??= failure;
        throw failure;
      }
    });
    state.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.finally(() => {
      state.pendingEvents -= 1;
      state.pendingBytes -= pendingBytes;
    });
  }

  async #flushDurable(sessionId: string): Promise<void> {
    if (this.#durability === undefined) return;
    const state = this.#durableQueue(sessionId);
    try {
      await withTimeout(
        state.tail,
        DURABLE_FLUSH_TIMEOUT_MS,
        `Timed out draining durable Event ingest for Session ${sessionId}`,
      );
    } catch (error) {
      state.failure ??= durabilityError(error);
      throw state.failure;
    }
    if (state.failure !== undefined) throw state.failure;
  }

  #durableQueue(sessionId: string): DurableQueueState {
    let state = this.#durableQueues.get(sessionId);
    if (state === undefined) {
      state = { pendingBytes: 0, pendingEvents: 0, tail: Promise.resolve() };
      this.#durableQueues.set(sessionId, state);
    }
    return state;
  }

  #tripDurability(sessionId: string, error: unknown): void {
    const state = this.#durableQueue(sessionId);
    state.failure ??= durabilityError(error);
    const session = this.store.getSession(sessionId);
    if (session?.activeExecutionId !== undefined) {
      const execution = this.store.getExecution(session.activeExecutionId);
      if (execution !== undefined) {
        execution.status = "UNKNOWN";
        execution.finishedAt ??= this.#timestamp();
        const action = this.store.getAction(execution.actionId);
        if (action?.type === "execute") action.status = "UNKNOWN";
      }
    }
    this.#executors.get(sessionId)?.close();
    this.#executors.delete(sessionId);
    if (session !== undefined && session.status !== "CLOSED" && session.status !== "BROKEN") {
      this.store.breakSession(session.id, session.generation);
    }
  }

  async #withMutationLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#mutationTails.set(sessionId, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#mutationTails.get(sessionId) === tail) {
        this.#mutationTails.delete(sessionId);
      }
    }
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

function hashRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new RuntimeError("INVALID_REQUEST", "Request contains a non-serializable value");
  }
  return serialized;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isInterrupt(delivery: ControlDelivery): boolean {
  return (
    (delivery.mode === "TTY_CONTROL" && delivery.control === "CTRL_C") ||
    (delivery.mode === "PROCESS_SIGNAL" &&
      (delivery.signal === "SIGINT" ||
        delivery.signal === "SIGTERM" ||
        delivery.signal === "SIGKILL"))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function durabilityError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError && error.code === "RUNTIME_UNAVAILABLE") return error;
  return new RuntimeError(
    "RUNTIME_UNAVAILABLE",
    "PostgreSQL durable journal is unavailable",
    { reason: errorMessage(error) },
    true,
  );
}

function isDurabilityFatal(error: unknown): boolean {
  return (
    !(error instanceof RuntimeError) ||
    error.code === "RUNTIME_UNAVAILABLE" ||
    error.code === "DELIVERY_UNKNOWN"
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
