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

import type { RuntimeStore, ShellExecutor, ShellExecutorFactory } from "./ports.js";

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;

export interface CreateSessionRequest {
  readonly shell: ShellKind;
  readonly workspaceRoot: string;
  readonly ownerId?: string;
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

export class RuntimeService {
  readonly #executors = new Map<string, ShellExecutor>();
  readonly #completions = new Map<string, Promise<Execution>>();
  readonly #started = new Map<string, Promise<void>>();

  public constructor(
    private readonly store: RuntimeStore,
    private readonly executorFactory: ShellExecutorFactory,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
      ownerId: request.ownerId ?? `owner_${process.pid.toString()}`,
      screenVersion: 0,
      shell: request.shell,
      status: "STARTING",
      workspaceRoot: request.workspaceRoot,
    };
    this.store.createSession(session);
    this.#event(session, "session.created", { shell: request.shell });
    this.#event(session, "session.shell_starting", {});

    try {
      const executor = await this.executorFactory.create({
        onOutput: (data) => this.#recordOutput(sessionId, generation, data),
        shell: request.shell,
        workspaceRoot: request.workspaceRoot,
      });
      this.#executors.set(sessionId, executor);
      const ready = this.store.markSessionReady(sessionId, generation);
      this.#event(ready, "session.shell_ready", {
        shellPid: executor.shellPid,
      });
      return ready;
    } catch (error) {
      const broken = this.store.breakSession(sessionId, generation);
      this.#event(broken, "session.broken", { reason: errorMessage(error) });
      throw error;
    }
  }

  public getSession(sessionId: string): Session {
    return this.#requireSession(sessionId);
  }

  public listSessions(): readonly Session[] {
    return this.store.listSessions();
  }

  public startExecute(request: ExecuteRequest): StartedExecution {
    if (request.command.includes("\0")) {
      throw new RuntimeError("INVALID_REQUEST", "Execute command cannot contain NUL bytes");
    }
    const requestHash = hashRequest({ command: request.command });
    const scope = `${request.sessionId}:execute:${request.actor.principal}`;
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
    const action: ExecuteAction = {
      acceptedAt,
      actionSequence: this.store.nextActionSequence(session.id, session.generation),
      actor: request.actor,
      command: request.command,
      executionId,
      id: actionId,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      sessionGeneration: session.generation,
      sessionId: session.id,
      status: "ACCEPTED",
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
    this.store.saveAction(action);
    this.store.bindIdempotency(scope, request.idempotencyKey, action.id);
    this.store.saveExecution(execution);
    this.#event(reserved, "action.accepted", {}, action, execution);
    action.status = "DISPATCHING";
    this.#event(reserved, "action.dispatching", {}, action, execution);

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
          this.#event(running, "execution.started", { observedCommand }, action, execution);
          startedDeferred.resolve();
        },
      })
      .then((result) => {
        execution.exitCode = result.exitCode;
        execution.cwd = result.cwd;
        execution.finishedAt = this.#timestamp();
        execution.output = result.output;
        execution.outputTruncated = result.outputTruncated;
        const interrupted = execution.interruptedRequested === true && result.exitCode !== 0;
        execution.status = interrupted ? "INTERRUPTED" : "COMPLETED";
        action.status = interrupted ? "INTERRUPTED" : "COMPLETED";
        const ready = this.store.releaseSession(session.id, session.generation, execution.id);
        this.#event(
          ready,
          interrupted ? "execution.interrupted" : "execution.completed",
          { cwd: result.cwd, exitCode: result.exitCode, outputTruncated: result.outputTruncated },
          action,
          execution,
        );
        this.#event(ready, "session.shell_ready", { cwd: result.cwd });
        return execution;
      })
      .catch((error: unknown) => {
        startedDeferred.reject(error);
        execution.status = "FAILED";
        execution.finishedAt = this.#timestamp();
        action.status = "FAILED";
        const current = this.store.getSession(session.id);
        if (current?.status !== "CLOSED") {
          const broken = this.store.breakSession(session.id, session.generation);
          this.#event(
            broken,
            "execution.failed",
            { reason: errorMessage(error) },
            action,
            execution,
          );
          this.#event(broken, "session.broken", { reason: errorMessage(error) });
        }
        throw error;
      });
    void completion.catch(() => undefined);
    this.#completions.set(execution.id, completion);
    return { action, completion, execution, started: startedDeferred.promise };
  }

  public async execute(request: ExecuteRequest): Promise<Execution> {
    return this.startExecute(request).completion;
  }

  public sendInput(request: InputRequest): InputAction {
    if (request.data.includes("\0")) {
      throw new RuntimeError("INVALID_REQUEST", "Input data cannot contain NUL bytes");
    }
    const requestHash = hashRequest({
      data: request.data,
      expectedScreenVersion: request.expectedScreenVersion,
      targetExecutionId: request.targetExecutionId,
    });
    const scope = `${request.sessionId}:input:${request.actor.principal}`;
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
    this.store.saveAction(action);
    this.store.bindIdempotency(scope, request.idempotencyKey, action.id);
    this.#event(session, "action.accepted", {}, action);
    try {
      this.#requireExecutor(session.id).writeInput(request.data);
      action.status = "DELIVERED";
      this.#event(
        session,
        "interaction.input_delivered",
        { byteLength: byteLength(request.data) },
        action,
      );
      return action;
    } catch (error) {
      action.status = "UNKNOWN";
      this.#event(session, "interaction.input_unknown", { reason: errorMessage(error) }, action);
      throw new RuntimeError(
        "DELIVERY_UNKNOWN",
        "PTY input delivery is uncertain",
        { actionId: action.id },
        false,
      );
    }
  }

  public sendControl(request: ControlRequest): ControlAction {
    const requestHash = hashRequest({
      delivery: request.delivery,
      targetExecutionId: request.targetExecutionId,
    });
    const scope = `${request.sessionId}:control:${request.actor.principal}`;
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
    this.store.saveAction(action);
    this.store.bindIdempotency(scope, request.idempotencyKey, action.id);
    this.#event(session, "action.accepted", {}, action);
    try {
      this.#requireExecutor(session.id).sendControl(request.delivery);
      const execution = this.#requireExecution(request.targetExecutionId);
      execution.interruptedRequested = isInterrupt(request.delivery);
      action.status = "DELIVERED";
      this.#event(session, "interaction.control_delivered", { delivery: request.delivery }, action);
      return action;
    } catch (error) {
      action.status = "UNKNOWN";
      this.#event(session, "interaction.control_unknown", { reason: errorMessage(error) }, action);
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

  public queryEvents(
    sessionId: string,
    generation: number,
    after = 0,
    requestedLimit = DEFAULT_EVENT_LIMIT,
  ): EventPage {
    this.#requireGeneration(sessionId, generation);
    const limit = Math.max(1, Math.min(requestedLimit, MAX_EVENT_LIMIT));
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

  public closeSession(sessionId: string, generation: number): Session {
    const session = this.#requireGeneration(sessionId, generation);
    this.#executors.get(sessionId)?.close();
    this.#executors.delete(sessionId);
    const closed = this.store.closeSession(sessionId, generation);
    this.#event(closed, "session.closed", { previousStatus: session.status });
    return closed;
  }

  #recordOutput(sessionId: string, generation: number, data: string): void {
    const current = this.store.getSession(sessionId);
    if (current === undefined || current.generation !== generation || current.status === "CLOSED") {
      return;
    }
    const screenVersion = this.store.bumpScreenVersion(sessionId, generation);
    this.#event(current, "terminal.pty_output", {
      byteLength: byteLength(data),
      data,
      screenVersion,
    });
  }

  #requireSession(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (session === undefined) {
      throw new RuntimeError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`, { sessionId });
    }
    return session;
  }

  #requireGeneration(sessionId: string, generation: number): Session {
    const session = this.#requireSession(sessionId);
    if (session.generation !== generation) {
      throw new RuntimeError(
        "SESSION_GENERATION_CHANGED",
        `Expected generation ${generation.toString()}, current ${session.generation.toString()}`,
        { currentGeneration: session.generation, sessionId },
      );
    }
    if (session.status === "BROKEN") {
      throw new RuntimeError("SESSION_BROKEN", `Session is broken: ${sessionId}`, { sessionId });
    }
    if (session.status === "CLOSED") {
      throw new RuntimeError("SESSION_NOT_READY", `Session is closed: ${sessionId}`, { sessionId });
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
    action?: SessionAction,
    execution?: Execution,
  ): SessionEvent {
    return this.store.appendEvent(session.id, session.generation, {
      observedAt: this.#timestamp(),
      payload,
      sessionGeneration: session.generation,
      sessionId: session.id,
      type,
      ...(action === undefined ? {} : { actionId: action.id, actor: action.actor }),
      ...(execution === undefined ? {} : { executionId: execution.id }),
    });
  }

  #timestamp(): string {
    return this.now().toISOString();
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
