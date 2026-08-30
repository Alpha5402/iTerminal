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
  TerminalScreenCellsResult,
  TerminalScreenDiffResult,
  TerminalScreenRegionResult,
  TerminalScreenSnapshot,
  TerminalScreenSearchResult,
  TerminalScreenWaitResult,
} from "@iterminal/domain";
import {
  CANONICAL_TERMINAL_COLUMNS,
  CANONICAL_TERMINAL_ROWS,
  RuntimeError,
} from "@iterminal/domain";

import type {
  DurableSessionEvent,
  RuntimeDurability,
  RuntimeServiceOptions,
  RuntimeStore,
  ShellExecutionResult,
  ShellExecutor,
  ShellExecutorFactory,
  TerminalScreenProjection,
  TerminalScreenProjectionFactory,
} from "./ports.js";

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;
const MAX_PENDING_DURABLE_EVENTS = 10_000;
const MAX_PENDING_DURABLE_BYTES = 8 * 1024 * 1024;
const DURABLE_FLUSH_TIMEOUT_MS = 30_000;
const MAX_SCREEN_QUERY_LENGTH = 1_024;
const MAX_SCREEN_SEARCH_MATCHES = 100;
const MAX_SCREEN_WAIT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_SCREEN_STABLE_MS = 30_000;
const MIN_SCREEN_STABLE_MS = 50;

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

export interface ScreenSearchRequest {
  readonly caseSensitive?: boolean;
  readonly generation: number;
  readonly maxMatches?: number;
  readonly query: string;
  readonly sessionId: string;
}

export interface ScreenDiffRequest {
  readonly afterVersion: number;
  readonly generation: number;
  readonly sessionId: string;
}

export interface ScreenCellsRequest {
  readonly columnCount: number;
  readonly generation: number;
  readonly rowCount: number;
  readonly sessionId: string;
  readonly startColumn: number;
  readonly startRow: number;
}

export interface ScreenRegionRequest {
  readonly columnCount: number;
  readonly generation: number;
  readonly rowCount: number;
  readonly sessionId: string;
  readonly startColumn: number;
  readonly startRow: number;
}

export type ScreenWaitCondition =
  | Readonly<{ type: "text"; text: string; caseSensitive?: boolean }>
  | Readonly<{ type: "version"; afterVersion: number }>
  | Readonly<{ type: "stable"; stableMilliseconds: number }>
  | Readonly<{ type: "execution_exit"; executionId: string }>;

export interface ScreenWaitRequest {
  readonly condition: ScreenWaitCondition;
  readonly generation: number;
  readonly sessionId: string;
  readonly timeoutMilliseconds: number;
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

interface ExecutionDispatchState {
  readonly action: ExecuteAction;
  readonly completion: Deferred<Execution>;
  dispatchTask?: Promise<void>;
  readonly execution: Execution;
  readonly started: Deferred<void>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

export class RuntimeService {
  readonly #executors = new Map<string, ShellExecutor>();
  readonly #screens = new Map<string, TerminalScreenProjection>();
  readonly #completions = new Map<string, Promise<Execution>>();
  readonly #started = new Map<string, Promise<void>>();
  readonly #durableQueues = new Map<string, DurableQueueState>();
  readonly #mutationTails = new Map<string, Promise<void>>();
  readonly #durability: RuntimeDurability | undefined;
  #ownerDurabilityFailure: RuntimeError | undefined;
  readonly #dispatchStates = new Map<string, ExecutionDispatchState>();
  readonly #executionDispatch: "external" | "immediate";
  readonly #hooks: NonNullable<RuntimeServiceOptions["hooks"]>;
  readonly #now: () => Date;
  readonly #ownerId: string;
  readonly #screenProjectionFactory: TerminalScreenProjectionFactory | undefined;

  public constructor(
    private readonly store: RuntimeStore,
    private readonly executorFactory: ShellExecutorFactory,
    options: RuntimeServiceOptions = {},
  ) {
    this.#durability = options.durability;
    this.#executionDispatch = options.executionDispatch ?? "immediate";
    this.#hooks = options.hooks ?? {};
    this.#now = options.now ?? (() => new Date());
    this.#ownerId = options.ownerId ?? `owner_${process.pid.toString()}`;
    this.#screenProjectionFactory = options.screenProjectionFactory;
  }

  public async createSession(request: CreateSessionRequest): Promise<Session> {
    this.#requireOwnerDurability();
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
      if (isDurabilityFatal(error)) this.#tripDurability(sessionId, error);
      throw durabilityError(error);
    }

    try {
      const screen = this.#screenProjectionFactory?.create({
        sessionGeneration: generation,
        sessionId,
      });
      if (screen !== undefined) this.#screens.set(sessionId, screen);
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
      try {
        await this.#enqueueDurable(session.id, 0, () =>
          this.#durability?.markSessionReady(ready, executor.shellPid, readyEvent),
        );
      } catch (error) {
        if (isDurabilityFatal(error)) this.#tripDurability(sessionId, error);
        throw error;
      }
      return ready;
    } catch (error) {
      this.#executors.get(sessionId)?.close();
      this.#executors.delete(sessionId);
      this.#screens.get(sessionId)?.dispose();
      this.#screens.delete(sessionId);
      const broken = this.store.breakSession(sessionId, generation);
      const brokenEvent = this.#event(
        broken,
        "session.broken",
        { reason: errorMessage(error) },
        { persist: false },
      );
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.markSessionBroken(broken, [brokenEvent], errorMessage(error)),
      ).catch((durableError: unknown) => this.#tripDurability(session.id, durableError));
      throw error;
    }
  }

  public getSession(sessionId: string): Session {
    return this.#requireSession(sessionId);
  }

  public listSessions(): readonly Session[] {
    return this.store.listSessions();
  }

  public async getScreen(sessionId: string, generation: number): Promise<TerminalScreenSnapshot> {
    this.#requireGeneration(sessionId, generation);
    const screen = this.#screens.get(sessionId);
    if (screen === undefined) {
      throw new RuntimeError(
        "RUNTIME_UNAVAILABLE",
        "This Runtime has no live Virtual Screen projection",
        { generation, sessionId },
      );
    }
    try {
      const snapshot = await screen.snapshot();
      this.#requireGeneration(sessionId, generation);
      return snapshot;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(
        "RUNTIME_UNAVAILABLE",
        "Virtual Screen projection is unavailable",
        { generation, reason: errorMessage(error), sessionId },
        true,
      );
    }
  }

  public async searchScreen(request: ScreenSearchRequest): Promise<TerminalScreenSearchResult> {
    validateScreenText(request.query, "Screen search query");
    const maxMatches = request.maxMatches ?? 20;
    if (
      !Number.isSafeInteger(maxMatches) ||
      maxMatches < 1 ||
      maxMatches > MAX_SCREEN_SEARCH_MATCHES
    ) {
      throw new RuntimeError(
        "INVALID_REQUEST",
        `Screen maxMatches must be between 1 and ${MAX_SCREEN_SEARCH_MATCHES.toString()}`,
      );
    }
    const screen = this.#requireScreen(request.sessionId, request.generation);
    try {
      const result = await screen.search({
        caseSensitive: request.caseSensitive ?? false,
        maxMatches,
        query: request.query,
      });
      this.#requireGeneration(request.sessionId, request.generation);
      return result;
    } catch (error) {
      throw this.#screenFailure(request.sessionId, request.generation, error);
    }
  }

  public async getScreenDiff(request: ScreenDiffRequest): Promise<TerminalScreenDiffResult> {
    if (!Number.isSafeInteger(request.afterVersion) || request.afterVersion < 0) {
      throw new RuntimeError(
        "INVALID_REQUEST",
        "Screen diff afterVersion must be a non-negative integer",
      );
    }
    const screen = this.#requireScreen(request.sessionId, request.generation);
    try {
      const result = await screen.diff(request.afterVersion);
      this.#requireGeneration(request.sessionId, request.generation);
      return result;
    } catch (error) {
      throw this.#screenFailure(request.sessionId, request.generation, error);
    }
  }

  public async getScreenCells(request: ScreenCellsRequest): Promise<TerminalScreenCellsResult> {
    validateScreenRegion(request);
    const screen = this.#requireScreen(request.sessionId, request.generation);
    try {
      const result = await screen.cells({
        columnCount: request.columnCount,
        rowCount: request.rowCount,
        startColumn: request.startColumn,
        startRow: request.startRow,
      });
      this.#requireGeneration(request.sessionId, request.generation);
      return result;
    } catch (error) {
      throw this.#screenFailure(request.sessionId, request.generation, error);
    }
  }

  public async getScreenRegion(request: ScreenRegionRequest): Promise<TerminalScreenRegionResult> {
    validateScreenRegion(request);
    const screen = this.#requireScreen(request.sessionId, request.generation);
    try {
      const result = await screen.region({
        columnCount: request.columnCount,
        rowCount: request.rowCount,
        startColumn: request.startColumn,
        startRow: request.startRow,
      });
      this.#requireGeneration(request.sessionId, request.generation);
      return result;
    } catch (error) {
      throw this.#screenFailure(request.sessionId, request.generation, error);
    }
  }

  public async waitForScreen(
    request: ScreenWaitRequest,
    signal?: AbortSignal,
  ): Promise<TerminalScreenWaitResult> {
    validateScreenWait(request);
    const startedAt = Date.now();
    const deadline = startedAt + request.timeoutMilliseconds;
    const screen = this.#requireScreen(request.sessionId, request.generation);
    try {
      if (request.condition.type === "execution_exit") {
        const execution = this.#requireExecution(request.condition.executionId);
        if (
          execution.sessionId !== request.sessionId ||
          execution.sessionGeneration !== request.generation
        ) {
          throw new RuntimeError(
            "EXECUTION_CHANGED",
            "Screen wait Execution does not belong to the requested Session generation",
            {
              executionId: execution.id,
              generation: request.generation,
              sessionId: request.sessionId,
            },
          );
        }
        let terminal = execution;
        if (!isExecutionTerminal(terminal.status)) {
          const waited = await waitForPromise(
            this.waitExecution(terminal.id),
            remainingMilliseconds(deadline),
            signal,
          );
          if (!waited.completed) {
            return waitResult(false, await screen.snapshot(), startedAt);
          }
          terminal = waited.value;
        }
        return waitResult(true, await screen.snapshot(), startedAt, terminal);
      }

      let snapshot = await screen.snapshot();
      for (;;) {
        if (screenConditionMatches(snapshot, request.condition)) {
          return waitResult(true, snapshot, startedAt);
        }
        const remaining = remainingMilliseconds(deadline);
        if (remaining <= 0) return waitResult(false, snapshot, startedAt);
        if (request.condition.type === "stable") {
          const interval = Math.min(request.condition.stableMilliseconds, remaining);
          const changed = await screen.waitForVersion(snapshot.screenVersion, interval, signal);
          if (changed === undefined) {
            return waitResult(
              interval === request.condition.stableMilliseconds,
              snapshot,
              startedAt,
            );
          }
          snapshot = changed;
          continue;
        }
        const changed = await screen.waitForVersion(snapshot.screenVersion, remaining, signal);
        if (changed === undefined) return waitResult(false, snapshot, startedAt);
        snapshot = changed;
      }
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw this.#screenFailure(request.sessionId, request.generation, error);
    }
  }

  public async recoverDurableOwner(reason: string): Promise<{
    readonly brokenSessions: number;
    readonly unknownExecutions: number;
  }> {
    try {
      const recovered = (await this.#durability?.recoverOwner(this.#ownerId, reason)) ?? {
        brokenSessions: 0,
        unknownExecutions: 0,
      };
      this.#ownerDurabilityFailure = undefined;
      return recovered;
    } catch (error) {
      const failure = durabilityError(error);
      this.#tripOwnerDurability(failure);
      throw failure;
    }
  }

  public isDurabilityHealthy(): boolean {
    return this.#ownerDurabilityFailure === undefined;
  }

  public reportDurabilityUnavailable(error: unknown): void {
    this.#tripOwnerDurability(durabilityError(error));
  }

  public shutdownLiveOwner(reason: string): void {
    for (const session of this.store.listSessions()) {
      this.#breakLiveSession(session, reason);
    }
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
    this.#requireExecutor(session.id);
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

    const dispatch = this.#createDispatchState(action, execution);
    if (this.#executionDispatch === "immediate") this.#startDispatch(dispatch);
    return this.#startedExecution(dispatch);
  }

  public async dispatchExecution(executionId: string): Promise<StartedExecution> {
    const execution = this.#requireExecution(executionId);
    return this.#withMutationLock(execution.sessionId, async () => {
      await this.#flushDurable(execution.sessionId);
      const dispatch = this.#dispatchStates.get(execution.id);
      if (dispatch === undefined) {
        throw new RuntimeError(
          "DELIVERY_UNKNOWN",
          "Execution has no dispatch state in this Runtime owner",
          { executionId },
          false,
        );
      }
      this.#startDispatch(dispatch);
      await dispatch.started.promise;
      return this.#startedExecution(dispatch);
    });
  }

  #createDispatchState(action: ExecuteAction, execution: Execution): ExecutionDispatchState {
    const state: ExecutionDispatchState = {
      action,
      completion: deferred<Execution>(),
      execution,
      started: deferred<void>(),
    };
    void state.started.promise.catch(() => undefined);
    void state.completion.promise.catch(() => undefined);
    this.#dispatchStates.set(execution.id, state);
    this.#started.set(execution.id, state.started.promise);
    this.#completions.set(execution.id, state.completion.promise);
    return state;
  }

  #startDispatch(state: ExecutionDispatchState): void {
    if (state.dispatchTask !== undefined) return;
    const task = this.#launchDispatch(state);
    state.dispatchTask = task;
    void task.catch((error: unknown) => {
      state.started.reject(error);
      state.completion.reject(error);
    });
  }

  async #launchDispatch(state: ExecutionDispatchState): Promise<void> {
    const { action, execution } = state;
    const session = this.#requireGeneration(execution.sessionId, execution.sessionGeneration);
    if (
      session.status !== "RESERVED" ||
      session.activeExecutionId !== execution.id ||
      execution.status !== "DISPATCHING"
    ) {
      throw new RuntimeError("DELIVERY_UNKNOWN", "Execution is not dispatchable", {
        activeExecutionId: session.activeExecutionId,
        executionId: execution.id,
        executionStatus: execution.status,
        sessionStatus: session.status,
      });
    }
    const writeAttemptedEvent = this.#eventDraft(
      session,
      "execution.write_attempted",
      {},
      action,
      execution,
    );
    try {
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.markExecutionWriteAttempted({
          action,
          event: writeAttemptedEvent,
          execution,
          session,
        }),
      );
    } catch (error) {
      this.#tripDurability(session.id, error);
      throw durabilityError(error);
    }
    this.store.appendEvent(session.id, session.generation, writeAttemptedEvent);

    const executor = this.#requireExecutor(session.id);
    let shellCompletion: Promise<ShellExecutionResult>;
    try {
      shellCompletion = executor.execute(execution.command, {
        onStarted: (observedCommand) => {
          try {
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
            ).then(
              () => state.started.resolve(),
              (error: unknown) => {
                this.#tripDurability(session.id, error);
                state.started.reject(durabilityError(error));
              },
            );
          } catch (error) {
            state.started.reject(error);
            throw error;
          }
        },
      });
      this.#hooks.afterExecutionWrite?.(execution);
    } catch (error) {
      await this.#failDispatchedExecution(state, error);
      throw error;
    }

    const result = shellCompletion.then(
      (completed) => this.#finishDispatchedExecution(state, completed),
      (error: unknown) => this.#failDispatchedExecution(state, error),
    );
    void result.then(state.completion.resolve, state.completion.reject);
    await state.started.promise;
  }

  async #finishDispatchedExecution(
    state: ExecutionDispatchState,
    result: ShellExecutionResult,
  ): Promise<Execution> {
    const { action, execution } = state;
    execution.exitCode = result.exitCode;
    execution.cwd = result.cwd;
    execution.finishedAt = this.#timestamp();
    execution.output = result.output;
    execution.outputTruncated = result.outputTruncated;
    const interrupted = execution.interruptedRequested === true && result.exitCode !== 0;
    execution.status = interrupted ? "INTERRUPTED" : "COMPLETED";
    action.status = interrupted ? "INTERRUPTED" : "COMPLETED";
    const ready = this.store.releaseSession(
      execution.sessionId,
      execution.sessionGeneration,
      execution.id,
    );
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
    this.#hooks.beforeExecutionFinishPersist?.(execution);
    try {
      await this.#enqueueDurable(execution.sessionId, 0, () =>
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
      this.#tripDurability(execution.sessionId, error);
      throw durabilityError(error);
    }
    return execution;
  }

  async #failDispatchedExecution(state: ExecutionDispatchState, error: unknown): Promise<never> {
    const { action, execution } = state;
    if (execution.status === "UNKNOWN") throw error;
    state.started.reject(error);
    execution.status = "FAILED";
    execution.finishedAt = this.#timestamp();
    action.status = "FAILED";
    const current = this.store.getSession(execution.sessionId);
    if (current?.status !== "CLOSED") {
      const broken = this.store.breakSession(execution.sessionId, execution.sessionGeneration);
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
      await this.#enqueueDurable(execution.sessionId, 0, () =>
        this.#durability?.failExecution({
          action,
          events: [failedEvent, brokenEvent],
          execution,
          reason: errorMessage(error),
          session: broken,
        }),
      ).catch((durableError: unknown) => this.#tripDurability(execution.sessionId, durableError));
    }
    throw error;
  }

  #startedExecution(state: ExecutionDispatchState): StartedExecution {
    return {
      action: state.action,
      completion: state.completion.promise,
      execution: state.execution,
      started: state.started.promise,
    };
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
    await this.#recordInteractionWriteAttempt(session, action, {
      byteLength: byteLength(request.data),
      interactionType: action.type,
    });
    try {
      this.#requireExecutor(session.id).writeInput(request.data);
      this.#hooks.afterInputWrite?.(action);
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
    await this.#recordInteractionWriteAttempt(session, action, {
      delivery: action.delivery,
      interactionType: action.type,
    });
    try {
      this.#requireExecutor(session.id).sendControl(request.delivery);
      this.#hooks.afterControlWrite?.(action);
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

  async #recordInteractionWriteAttempt(
    session: Session,
    action: InputAction | ControlAction,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const event = this.#eventDraft(
      session,
      "interaction.write_attempted",
      payload,
      action,
      this.#requireExecution(action.targetExecutionId),
    );
    try {
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.markInteractionWriteAttempted(action, event, this.#ownerId),
      );
    } catch (error) {
      this.#tripDurability(session.id, error);
      throw durabilityError(error);
    }
    this.store.appendEvent(session.id, session.generation, event);
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
      try {
        return await this.#durability.queryEvents(sessionId, generation, after, limit);
      } catch (error) {
        if (isDurabilityFatal(error)) this.#tripDurability(sessionId, error);
        throw durabilityError(error);
      }
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
      this.#markActiveDispatchUnknown(session, "Session closed before Execution outcome");
      this.#executors.get(sessionId)?.close();
      this.#executors.delete(sessionId);
      this.#screens.get(sessionId)?.dispose();
      this.#screens.delete(sessionId);
      const closed = this.store.closeSession(sessionId, generation);
      const closedEvent = this.#event(
        closed,
        "session.closed",
        { previousStatus },
        { persist: false },
      );
      if (flushFailure !== undefined) throw durabilityError(flushFailure);
      try {
        await this.#enqueueDurable(sessionId, 0, () =>
          this.#durability?.closeSession(closed, closedEvent),
        );
      } catch (error) {
        if (isDurabilityFatal(error)) this.#tripDurability(sessionId, error);
        throw error;
      }
      return closed;
    });
  }

  #recordOutput(sessionId: string, generation: number, data: string): void {
    const current = this.store.getSession(sessionId);
    if (current === undefined || current.generation !== generation || current.status === "CLOSED") {
      return;
    }
    const screenVersion = this.store.bumpScreenVersion(sessionId, generation);
    this.#screens.get(sessionId)?.write(data, screenVersion);
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

  #requireScreen(sessionId: string, generation: number): TerminalScreenProjection {
    this.#requireGeneration(sessionId, generation);
    const screen = this.#screens.get(sessionId);
    if (screen === undefined) {
      throw new RuntimeError(
        "RUNTIME_UNAVAILABLE",
        "This Runtime has no live Virtual Screen projection",
        { generation, sessionId },
      );
    }
    return screen;
  }

  #screenFailure(sessionId: string, generation: number, error: unknown): RuntimeError {
    try {
      this.#requireGeneration(sessionId, generation);
    } catch (stateError) {
      if (stateError instanceof RuntimeError) return stateError;
    }
    return new RuntimeError(
      "RUNTIME_UNAVAILABLE",
      "Virtual Screen projection is unavailable",
      { generation, reason: errorMessage(error), sessionId },
      true,
    );
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
    this.#requireOwnerDurability();
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
          durabilityScope: "session",
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
    this.#requireOwnerDurability();
    const state = this.#durableQueue(sessionId);
    try {
      await withTimeout(
        state.tail,
        DURABLE_FLUSH_TIMEOUT_MS,
        `Timed out draining durable Event ingest for Session ${sessionId}`,
      );
    } catch (error) {
      state.failure ??= durabilityError(error);
      this.#tripDurability(sessionId, error);
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
    if (isOwnerDurabilityFailure(error)) {
      this.#tripOwnerDurability(durabilityError(error));
      return;
    }
    const state = this.#durableQueue(sessionId);
    state.failure ??= durabilityError(error);
    const session = this.store.getSession(sessionId);
    if (session !== undefined) this.#breakLiveSession(session, errorMessage(error));
  }

  #tripOwnerDurability(failure: RuntimeError): void {
    this.#ownerDurabilityFailure ??= failure;
    const ownerFailure = this.#ownerDurabilityFailure;
    for (const session of this.store.listSessions()) {
      const state = this.#durableQueue(session.id);
      state.failure ??= ownerFailure;
      this.#breakLiveSession(session, ownerFailure.message);
    }
  }

  #breakLiveSession(session: Session, reason: string): void {
    this.#markActiveDispatchUnknown(session, reason);
    this.#executors.get(session.id)?.close();
    this.#executors.delete(session.id);
    if (session.status !== "CLOSED" && session.status !== "BROKEN") {
      this.store.breakSession(session.id, session.generation);
    }
  }

  #requireOwnerDurability(): void {
    if (this.#ownerDurabilityFailure !== undefined) throw this.#ownerDurabilityFailure;
  }

  #markActiveDispatchUnknown(session: Session, reason: string): void {
    if (session.activeExecutionId === undefined) return;
    const execution = this.store.getExecution(session.activeExecutionId);
    if (execution === undefined || isExecutionTerminal(execution.status)) return;
    execution.status = "UNKNOWN";
    execution.finishedAt ??= this.#timestamp();
    const action = this.store.getAction(execution.actionId);
    if (action?.type === "execute") action.status = "UNKNOWN";
    const dispatch = this.#dispatchStates.get(execution.id);
    const failure = new RuntimeError(
      "DELIVERY_UNKNOWN",
      "Execution outcome is unknown",
      { executionId: execution.id, reason },
      false,
    );
    dispatch?.started.reject(failure);
    dispatch?.completion.reject(failure);
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

function validateScreenWait(request: ScreenWaitRequest): void {
  if (
    !Number.isSafeInteger(request.timeoutMilliseconds) ||
    request.timeoutMilliseconds < 1 ||
    request.timeoutMilliseconds > MAX_SCREEN_WAIT_TIMEOUT_MS
  ) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      `Screen wait timeout must be between 1 and ${MAX_SCREEN_WAIT_TIMEOUT_MS.toString()} milliseconds`,
    );
  }
  switch (request.condition.type) {
    case "text":
      validateScreenText(request.condition.text, "Screen wait text");
      break;
    case "version":
      if (
        !Number.isSafeInteger(request.condition.afterVersion) ||
        request.condition.afterVersion < 0
      ) {
        throw new RuntimeError(
          "INVALID_REQUEST",
          "Screen wait afterVersion must be a non-negative integer",
        );
      }
      break;
    case "stable":
      if (
        !Number.isSafeInteger(request.condition.stableMilliseconds) ||
        request.condition.stableMilliseconds < MIN_SCREEN_STABLE_MS ||
        request.condition.stableMilliseconds > MAX_SCREEN_STABLE_MS
      ) {
        throw new RuntimeError(
          "INVALID_REQUEST",
          `Screen stable interval must be between ${MIN_SCREEN_STABLE_MS.toString()} and ${MAX_SCREEN_STABLE_MS.toString()} milliseconds`,
        );
      }
      break;
    case "execution_exit":
      if (request.condition.executionId.length === 0) {
        throw new RuntimeError("INVALID_REQUEST", "Screen wait executionId is required");
      }
      break;
  }
}

function validateScreenRegion(request: ScreenRegionRequest): void {
  if (!validScreenRange(request.startRow, request.rowCount, CANONICAL_TERMINAL_ROWS)) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      `Screen row region must fit within ${CANONICAL_TERMINAL_ROWS.toString()} rows`,
    );
  }
  if (!validScreenRange(request.startColumn, request.columnCount, CANONICAL_TERMINAL_COLUMNS)) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      `Screen column region must fit within ${CANONICAL_TERMINAL_COLUMNS.toString()} columns`,
    );
  }
}

function validScreenRange(start: number, count: number, maximum: number): boolean {
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(count) &&
    start >= 0 &&
    count >= 1 &&
    start + count <= maximum
  );
}

function validateScreenText(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_SCREEN_QUERY_LENGTH ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes("\0")
  ) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      `${label} must be 1-${MAX_SCREEN_QUERY_LENGTH.toString()} characters without line breaks or NUL`,
    );
  }
}

function screenConditionMatches(
  snapshot: TerminalScreenSnapshot,
  condition: Exclude<ScreenWaitCondition, { type: "execution_exit" }>,
): boolean {
  switch (condition.type) {
    case "text": {
      const needle =
        condition.caseSensitive === true ? condition.text : condition.text.toLowerCase();
      return snapshot.lines.some((line) =>
        (condition.caseSensitive === true ? line : line.toLowerCase()).includes(needle),
      );
    }
    case "version":
      return snapshot.screenVersion > condition.afterVersion;
    case "stable":
      return false;
  }
}

function waitResult(
  matched: boolean,
  snapshot: TerminalScreenSnapshot,
  startedAt: number,
  execution?: Execution,
): TerminalScreenWaitResult {
  return {
    matched,
    reason: matched ? "condition" : "timeout",
    snapshot,
    waitedMilliseconds: Math.max(0, Date.now() - startedAt),
    ...(execution === undefined ? {} : { execution }),
  };
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

type WaitForPromiseResult<T> =
  Readonly<{ completed: true; value: T }> | Readonly<{ completed: false }>;

function waitForPromise<T>(
  work: Promise<T>,
  timeoutMilliseconds: number,
  signal?: AbortSignal,
): Promise<WaitForPromiseResult<T>> {
  if (timeoutMilliseconds <= 0) return Promise.resolve({ completed: false });
  if (signal?.aborted === true) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    let onAbort: (() => void) | undefined;
    const finish = (result: WaitForPromiseResult<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(() => finish({ completed: false }), timeoutMilliseconds);
    if (signal !== undefined) {
      onAbort = () => fail(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
    }
    void work.then((value) => finish({ completed: true, value }), fail);
  });
}

function abortError(): Error {
  const error = new Error("Screen wait aborted");
  error.name = "AbortError";
  return error;
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

function isExecutionTerminal(status: Execution["status"]): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "INTERRUPTED" ||
    status === "UNKNOWN"
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
    {
      durabilityScope: isOwnerDurabilityFailure(error) ? "owner" : "session",
      reason: errorMessage(error),
    },
    true,
  );
}

function isOwnerDurabilityFailure(error: unknown): boolean {
  if (error instanceof RuntimeError) {
    if (error.code !== "RUNTIME_UNAVAILABLE") return false;
    return error.details.durabilityScope !== "session";
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String(error.code);
    if (code === "57014") return false;
    if (code.startsWith("08") || OWNER_CONNECTION_ERROR_CODES.has(code)) return true;
  }
  return true;
}

const OWNER_CONNECTION_ERROR_CODES = new Set([
  "57P01",
  "57P02",
  "57P03",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);

function isDurabilityFatal(error: unknown): boolean {
  return (
    !(error instanceof RuntimeError) ||
    error.code === "RUNTIME_UNAVAILABLE" ||
    error.code === "DELIVERY_UNKNOWN"
  );
}

function deferred<T>(): Deferred<T> {
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
