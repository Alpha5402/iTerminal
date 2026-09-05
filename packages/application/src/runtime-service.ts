import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import type {
  Actor,
  ActorCapability,
  AgentExecuteApprovalPolicy,
  Approval,
  ApprovalDecision,
  ApprovalStatus,
  ControlAction,
  ControlDelivery,
  EventPage,
  ExecuteAction,
  Execution,
  InputAction,
  InputContext,
  LineInputPrecondition,
  InputPolicyMode,
  InteractionGuard,
  InteractionState,
  ResizeAction,
  SecretInputAction,
  SensitiveInput,
  SensitiveInputOutcome,
  Session,
  SessionAction,
  SessionEvent,
  SessionForkLimitation,
  SessionForkResult,
  ShellCheckpoint,
  ShellCheckpointView,
  ShellKind,
  TerminalScreenCellsResult,
  TerminalScreenDiffResult,
  TerminalScreenRegionResult,
  TerminalScreenSnapshot,
  TerminalScreenSearchResult,
  TerminalScreenWaitResult,
  TerminalStateObservation,
  TerminalCursorResponse,
} from "@iterminal/domain";
import {
  actorHasCapability,
  DEFAULT_APPROVAL_TTL_MS,
  DEFAULT_INTERACTION_GUARD_TTL_MS,
  MAX_APPROVAL_TTL_MS,
  MAX_INTERACTION_GUARD_RENEWALS,
  MAX_INTERACTION_GUARD_TTL_MS,
  MIN_INTERACTION_GUARD_TTL_MS,
  MIN_APPROVAL_TTL_MS,
  MAX_TERMINAL_COLUMNS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLUMNS,
  MIN_TERMINAL_ROWS,
  RuntimeError,
  isCanonicalActorCapabilities,
  isTerminalResponseAction,
  TERMINAL_RESPONSE_ACTOR,
} from "@iterminal/domain";
import { deliveredInputState, validateLineInput } from "./input-context.js";

import type {
  DurableSessionEvent,
  DurableForkAdmission,
  DurableOwnerRecoveryResult,
  DurableRebuildableSession,
  RuntimeOwnerIdentity,
  RuntimeDurability,
  RuntimeServiceOptions,
  RuntimeStore,
  SessionFence,
  SessionLease,
  ShellExecutionResult,
  ShellExecutor,
  ShellExecutorFactory,
  ShellExecutorLifecycleEvent,
  TerminalScreenProjection,
  TerminalScreenProjectionFactory,
} from "./ports.js";
import { classifyTerminalState } from "./terminal-state.js";

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;
const MAX_PENDING_DURABLE_EVENTS = 10_000;
const MAX_PENDING_DURABLE_BYTES = 8 * 1024 * 1024;
const MAX_PTY_OUTPUT_EVENT_BYTES = 8 * 1024;
const PTY_OUTPUT_FLUSH_MILLISECONDS = 50;
const DURABLE_FLUSH_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_LEASE_MILLISECONDS = 15_000;
const MAX_SCREEN_QUERY_LENGTH = 1_024;
const MAX_SCREEN_SEARCH_MATCHES = 100;
const MAX_SCREEN_WAIT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_SCREEN_STABLE_MS = 30_000;
const MIN_SCREEN_STABLE_MS = 50;
const DEFAULT_CHECKPOINT_ENVIRONMENT_KEYS = ["LANG", "LC_ALL", "LC_CTYPE"] as const;
const MAX_CHECKPOINT_ENVIRONMENT_KEYS = 32;
const MAX_CHECKPOINT_ENVIRONMENT_VALUE_BYTES = 4_096;
const CHECKPOINT_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const SENSITIVE_CHECKPOINT_ENVIRONMENT_NAME =
  /(?:^|_)(?:APIKEY|AUTH|COOKIE|CREDENTIALS?|KEY|PASS|PASSWORD|SECRET|TOKEN)(?:_|$)/iu;
const RUNTIME_UNSAFE_CHECKPOINT_ENVIRONMENT_NAME =
  /^(?:BASHOPTS|BASH_ENV|ENV|IFS|PROMPT_COMMAND|SHELLOPTS|ZDOTDIR|LD_.+|DYLD_.+|ITERMINAL_.+)$/u;
const FORK_LIMITATIONS: readonly SessionForkLimitation[] = [
  "process_state_not_copied",
  "repl_editor_state_not_copied",
  "shell_implicit_state_not_copied",
  "workspace_filesystem_shared",
  "filtered_environment_only",
];

export interface CreateSessionRequest {
  readonly idempotencyKey?: string;
  readonly shell: ShellKind;
  readonly workspaceRoot: string;
}

export interface ForkSessionRequest {
  readonly actor: Actor;
  readonly allowStale: boolean;
  readonly expectedCheckpointVersion: number;
  readonly idempotencyKey: string;
  readonly sessionGeneration: number;
  readonly sessionId: string;
}

export interface ExecuteRequest {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly actor: Actor;
  readonly command: string;
  readonly idempotencyKey: string;
  readonly approvalId?: string;
}

export interface RequestExecuteApprovalRequest {
  readonly actionIdempotencyKey: string;
  readonly actor: Actor;
  readonly command: string;
  readonly reason: string;
  readonly requestIdempotencyKey: string;
  readonly sessionGeneration: number;
  readonly sessionId: string;
  readonly ttlMilliseconds?: number;
}

export interface GetApprovalRequest {
  readonly actor: Actor;
  readonly approvalId: string;
  readonly sessionGeneration: number;
  readonly sessionId: string;
}

export interface ListApprovalsRequest {
  readonly actor: Actor;
  readonly sessionGeneration: number;
  readonly sessionId: string;
  readonly status?: ApprovalStatus;
}

export interface DecideApprovalRequest extends GetApprovalRequest {
  readonly decision: ApprovalDecision;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly reason: string;
}

export interface InputRequest {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly actor: Actor;
  readonly targetExecutionId: string;
  readonly data: string;
  readonly expectedScreenVersion?: number;
  readonly lineInput?: LineInputPrecondition;
  readonly idempotencyKey: string;
}

export interface BeginSecretInputRequest {
  readonly actor: Actor;
  readonly data: string;
  readonly expectedScreenVersion?: number;
  readonly idempotencyKey: string;
  readonly sessionGeneration: number;
  readonly sessionId: string;
  readonly targetExecutionId: string;
}

export interface GetSensitiveInputRequest {
  readonly actor: Actor;
  readonly sessionGeneration: number;
  readonly sessionId: string;
}

export interface FinishSensitiveInputRequest extends GetSensitiveInputRequest {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly outcome: SensitiveInputOutcome;
  readonly sensitiveInputId: string;
}

export interface ControlRequest {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly actor: Actor;
  readonly targetExecutionId: string;
  readonly delivery: ControlDelivery;
  readonly bypassGuard?: boolean;
  readonly idempotencyKey: string;
}

export interface ResizeRequest {
  readonly actor: Actor;
  readonly columns: number;
  readonly expectedGeometryVersion: number;
  readonly idempotencyKey: string;
  readonly rows: number;
  readonly sessionGeneration: number;
  readonly sessionId: string;
}

export interface SetInputPolicyRequest {
  readonly actor: Actor;
  readonly expectedVersion: number;
  readonly mode: InputPolicyMode;
  readonly sessionGeneration: number;
  readonly sessionId: string;
}

export interface AcquireInteractionGuardRequest {
  readonly actor: Actor;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly sessionGeneration: number;
  readonly sessionId: string;
  readonly ttlMilliseconds?: number;
}

export interface RenewInteractionGuardRequest {
  readonly actor: Actor;
  readonly expectedVersion: number;
  readonly guardId: string;
  readonly sessionGeneration: number;
  readonly sessionId: string;
  readonly ttlMilliseconds?: number;
}

export interface ReleaseInteractionGuardRequest {
  readonly actor: Actor;
  readonly expectedVersion: number;
  readonly guardId: string;
  readonly sessionGeneration: number;
  readonly sessionId: string;
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
  readonly actor?: Actor;
  readonly execution?: Execution;
  readonly persist?: boolean;
}

interface DurableQueueState {
  failure?: RuntimeError;
  pendingBytes: number;
  pendingEvents: number;
  tail: Promise<void>;
}

interface PtyOutputBuffer {
  readonly actionId?: string;
  readonly actor?: Actor;
  byteLength: number;
  data: string;
  readonly executionId?: string;
  readonly generation: number;
  readonly observedAt: string;
  screenVersion: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ExecutionDispatchState {
  readonly action: ExecuteAction;
  readonly completion: Deferred<Execution>;
  dispatchTask?: Promise<void>;
  readonly execution: Execution;
  readonly started: Deferred<void>;
  writeAccepted: boolean;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

interface ForkReplay {
  readonly requestHash: string;
  readonly result: SessionForkResult;
}

interface SessionCreationReplay {
  readonly promise: Promise<Session>;
  readonly requestHash: string;
}

interface ApprovalRequestReplay {
  readonly approvalId: string;
  readonly requestHash: string;
}

type IdempotentCreateSessionRequest = Omit<CreateSessionRequest, "idempotencyKey"> & {
  readonly idempotencyKey: string;
};

export class RuntimeService {
  readonly #executors = new Map<string, ShellExecutor>();
  readonly #executorIdentities = new Map<
    string,
    Readonly<{ executorId: string; generation: number }>
  >();
  readonly #screens = new Map<string, TerminalScreenProjection>();
  readonly #completions = new Map<string, Promise<Execution>>();
  readonly #started = new Map<string, Promise<void>>();
  readonly #durableQueues = new Map<string, DurableQueueState>();
  readonly #ptyOutputBuffers = new Map<string, PtyOutputBuffer>();
  readonly #actors = new Map<string, Actor>();
  readonly #approvals = new Map<string, Approval>();
  readonly #approvalRequestReplays = new Map<string, ApprovalRequestReplay>();
  readonly #agentExecuteApproval: AgentExecuteApprovalPolicy;
  readonly #mutationTails = new Map<string, Promise<void>>();
  readonly #interactionStates = new Map<string, InteractionState>();
  readonly #inputContexts = new Map<string, InputContext>();
  readonly #sensitiveInputs = new Map<string, SensitiveInput>();
  readonly #sessionLeases = new Map<string, SessionLease>();
  readonly #sessionCreations = new Map<string, SessionCreationReplay>();
  readonly #checkpoints = new Map<string, ShellCheckpoint>();
  readonly #checkpointInvalid = new Set<string>();
  readonly #forkReplays = new Map<string, ForkReplay>();
  readonly #checkpointEnvironmentKeys: readonly string[];
  readonly #durability: RuntimeDurability | undefined;
  #ownerDurabilityFailure: RuntimeError | undefined;
  readonly #dispatchStates = new Map<string, ExecutionDispatchState>();
  readonly #executionDispatch: "external" | "immediate";
  readonly #hooks: NonNullable<RuntimeServiceOptions["hooks"]>;
  readonly #now: () => Date;
  readonly #ownerId: string;
  #ownerIdentity: RuntimeOwnerIdentity;
  readonly #sessionLeaseMilliseconds: number;
  readonly #screenProjectionFactory: TerminalScreenProjectionFactory | undefined;
  readonly #terminalResponseBudgets = new Map<
    string,
    { pending: number; count: number; since: number }
  >();

  public constructor(
    private readonly store: RuntimeStore,
    private readonly executorFactory: ShellExecutorFactory,
    options: RuntimeServiceOptions = {},
  ) {
    this.#durability = options.durability;
    this.#agentExecuteApproval = options.agentExecuteApproval ?? "optional";
    this.#checkpointEnvironmentKeys = validateCheckpointEnvironmentKeys(
      options.checkpointEnvironmentKeys ?? DEFAULT_CHECKPOINT_ENVIRONMENT_KEYS,
    );
    this.#executionDispatch = options.executionDispatch ?? "immediate";
    this.#hooks = options.hooks ?? {};
    this.#now = options.now ?? (() => new Date());
    this.#ownerId = options.ownerId ?? `owner_${process.pid.toString()}`;
    this.#ownerIdentity = {
      epoch: 1,
      instanceId: `in_process_${process.pid.toString()}`,
      ownerId: this.#ownerId,
    };
    this.#sessionLeaseMilliseconds = requirePositiveInteger(
      options.sessionLeaseMilliseconds ?? DEFAULT_SESSION_LEASE_MILLISECONDS,
      "sessionLeaseMilliseconds",
    );
    this.#screenProjectionFactory = options.screenProjectionFactory;
  }

  public activateDurableOwner(owner: RuntimeOwnerIdentity): void {
    if (owner.ownerId !== this.#ownerId) {
      throw new RuntimeError("OWNER_LEASE_LOST", "Runtime owner identity changed logical owner", {
        configuredOwnerId: this.#ownerId,
        ownerId: owner.ownerId,
      });
    }
    this.#ownerIdentity = { ...owner };
  }

  public async renewDurableSessionLeases(): Promise<number> {
    if (this.#durability === undefined) return 0;
    this.#requireOwnerDurability();
    const leases = [...this.#sessionLeases.values()].filter((lease) => {
      const session = this.store.getSession(lease.sessionId);
      return (
        session !== undefined &&
        session.generation === lease.generation &&
        session.status !== "BROKEN" &&
        session.status !== "CLOSED"
      );
    });
    try {
      const renewed = await this.#durability.renewSessionLeases(
        this.#ownerIdentity,
        leases,
        this.#sessionLeaseMilliseconds,
      );
      if (renewed.length !== leases.length) {
        throw new RuntimeError(
          "SESSION_LEASE_LOST",
          "Runtime renewed only part of its exact Session lease set",
          { expected: leases.length, renewed: renewed.length },
          false,
        );
      }
      for (const lease of renewed) this.#sessionLeases.set(lease.sessionId, lease);
      return renewed.length;
    } catch (error) {
      const failure = durabilityError(error);
      this.#tripOwnerDurability(failure);
      throw failure;
    }
  }

  public createSession(request: CreateSessionRequest): Promise<Session> {
    const normalized: IdempotentCreateSessionRequest = {
      ...request,
      idempotencyKey: request.idempotencyKey ?? `session_create_${randomUUID()}`,
    };
    validateIdempotencyKey(normalized.idempotencyKey);
    const requestHash = sessionCreationRequestHash(normalized);
    const replay = this.#sessionCreations.get(normalized.idempotencyKey);
    if (replay !== undefined) {
      if (replay.requestHash !== requestHash) {
        return Promise.reject(
          new RuntimeError(
            "IDEMPOTENCY_KEY_REUSED",
            "Session creation idempotency key was already used with a different request",
            { idempotencyKey: normalized.idempotencyKey },
          ),
        );
      }
      return replay.promise;
    }
    const promise = this.#createSession(normalized, requestHash);
    this.#sessionCreations.set(normalized.idempotencyKey, { promise, requestHash });
    void promise.then(
      () => this.#forgetDurableSessionCreation(normalized.idempotencyKey, promise),
      () => this.#forgetDurableSessionCreation(normalized.idempotencyKey, promise),
    );
    return promise;
  }

  #forgetDurableSessionCreation(idempotencyKey: string, promise: Promise<Session>): void {
    if (this.#durability === undefined) return;
    if (this.#sessionCreations.get(idempotencyKey)?.promise === promise) {
      this.#sessionCreations.delete(idempotencyKey);
    }
  }

  async #createSession(
    request: IdempotentCreateSessionRequest,
    requestHash: string,
  ): Promise<Session> {
    this.#requireOwnerDurability();
    const workspaceRoot = await canonicalWorkspace(request.workspaceRoot);
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
      workspaceRoot,
    };
    this.#interactionStates.set(sessionId, {
      policy: "human_guarded",
      sessionGeneration: generation,
      sessionId,
      version: 1,
    });
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
      const creation = await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.createSession(
          session,
          [createdEvent, startingEvent],
          this.#ownerIdentity,
          this.#sessionLeaseMilliseconds,
          { idempotencyKey: request.idempotencyKey, requestHash },
        ),
      );
      if (this.#durability !== undefined) {
        if (creation === undefined) throw missingSessionLease(session);
        if (creation.kind === "replay") {
          const replay = this.store.getSession(creation.sessionId);
          if (replay === undefined) {
            throw new RuntimeError(
              "RUNTIME_UNAVAILABLE",
              "Durable Session creation replay is not present in the live owner",
              { replaySessionId: creation.sessionId },
              true,
            );
          }
          this.#interactionStates.delete(sessionId);
          this.store.deleteSession(sessionId, generation);
          return replay;
        }
        this.#sessionLeases.set(session.id, creation.lease);
      }
    } catch (error) {
      this.#interactionStates.delete(sessionId);
      this.store.breakSession(sessionId, generation);
      if (isDurabilityFatal(error)) this.#tripDurability(sessionId, error);
      throw durabilityError(error);
    }

    return this.#launchSession(session);
  }

  public getSessionCheckpoint(sessionId: string, generation: number): ShellCheckpointView {
    const session = this.#requireExactGeneration(sessionId, generation);
    if (session.status === "READY" && this.#checkpointInvalid.has(sessionId)) {
      throw new RuntimeError(
        "CHECKPOINT_INVALID",
        "The current READY Shell cwd cannot be reconstructed inside its workspace",
        { generation, sessionId },
      );
    }
    const checkpoint = this.#checkpoints.get(sessionId);
    if (checkpoint === undefined || checkpoint.sourceGeneration !== generation) {
      throw new RuntimeError(
        "CHECKPOINT_NOT_FOUND",
        "No valid Shell checkpoint exists for this Session generation",
        { generation, sessionId },
      );
    }
    return checkpointView(checkpoint, session.status, this.#now());
  }

  public forkSession(request: ForkSessionRequest): Promise<SessionForkResult> {
    return this.#withMutationLock(request.sessionId, async () => {
      this.#requireOwnerDurability();
      this.#requireActorCapability(request.actor, "session.fork");
      validateIdempotencyKey(request.idempotencyKey);
      const requestHash = hashRequest({
        actor: request.actor,
        allowStale: request.allowStale,
        expectedCheckpointVersion: request.expectedCheckpointVersion,
        sessionGeneration: request.sessionGeneration,
        sessionId: request.sessionId,
      });
      const replayScope = forkReplayScope(request);
      const replay = this.#forkReplays.get(replayScope);
      if (replay !== undefined) {
        if (replay.requestHash !== requestHash) {
          throw new RuntimeError(
            "IDEMPOTENCY_KEY_REUSED",
            "Fork idempotency key was already used with a different request",
            { childSessionId: replay.result.session.id },
          );
        }
        return { ...replay.result, replayed: true };
      }

      const parent = this.#requireExactGeneration(request.sessionId, request.sessionGeneration);
      if (parent.status === "CLOSED" || parent.status === "STARTING") {
        throw new RuntimeError("SESSION_NOT_READY", `Cannot fork a Session in ${parent.status}`, {
          sessionId: parent.id,
          status: parent.status,
        });
      }
      let checkpoint = this.#checkpoints.get(parent.id);
      if (checkpoint === undefined || checkpoint.sourceGeneration !== parent.generation) {
        throw new RuntimeError(
          "CHECKPOINT_NOT_FOUND",
          "No completed READY checkpoint exists for this Session generation",
          { generation: parent.generation, sessionId: parent.id },
        );
      }
      if (checkpoint.version !== request.expectedCheckpointVersion) {
        throw new RuntimeError(
          "CHECKPOINT_CHANGED",
          "The selected Shell checkpoint version is stale",
          {
            currentCheckpointVersion: checkpoint.version,
            expectedCheckpointVersion: request.expectedCheckpointVersion,
            sessionId: parent.id,
          },
          true,
        );
      }
      const selectedCheckpoint = checkpoint;
      const sourceStatus = parent.status;
      const stale = sourceStatus !== "READY";
      if (stale && !request.allowStale) {
        throw new RuntimeError(
          "CHECKPOINT_STALE",
          "Parent is not READY; explicitly acknowledge the last completed checkpoint",
          {
            checkpointVersion: checkpoint.version,
            observedAt: checkpoint.observedAt,
            sessionId: parent.id,
            status: parent.status,
          },
        );
      }
      if (!stale) {
        const observation = this.#requireExecutor(parent.id).checkpoint();
        checkpoint = await this.#buildCheckpoint(parent, observation, checkpoint.version + 1);
      } else {
        await validateCheckpointPath(checkpoint);
      }

      const createdAt = this.#timestamp();
      const child: Session = {
        actionSequence: 0,
        createdAt,
        eventSequence: 0,
        generation: 1,
        id: `ses_${randomUUID()}`,
        lineage: {
          checkpointHash: checkpoint.contentHash,
          checkpointVersion: checkpoint.version,
          forkedAt: createdAt,
          parentGeneration: parent.generation,
          parentSessionId: parent.id,
        },
        ownerId: this.#ownerId,
        screenVersion: 0,
        shell: checkpoint.shell,
        status: "STARTING",
        workspaceRoot: checkpoint.workspaceRoot,
      };
      this.#interactionStates.set(child.id, {
        policy: "human_guarded",
        sessionGeneration: child.generation,
        sessionId: child.id,
        version: 1,
      });
      this.store.createSession(child);
      const requestedEvent = this.#eventDraft(
        parent,
        "session.fork_requested",
        {
          checkpointHash: checkpoint.contentHash,
          checkpointVersion: checkpoint.version,
          childSessionId: child.id,
          stale,
        },
        undefined,
        undefined,
        request.actor,
      );
      const createdEvent = this.#eventDraft(
        child,
        "session.created",
        {
          parentGeneration: parent.generation,
          parentSessionId: parent.id,
          shell: child.shell,
        },
        undefined,
        undefined,
        request.actor,
      );
      const startingEvent = this.#eventDraft(child, "session.shell_starting", {
        checkpointVersion: checkpoint.version,
      });
      const admission: DurableForkAdmission = {
        actor: request.actor,
        checkpoint,
        child,
        childEvents: [createdEvent, startingEvent],
        expectedCheckpointHash: selectedCheckpoint.contentHash,
        expectedCheckpointVersion: selectedCheckpoint.version,
        expectedParentStatus: sourceStatus,
        idempotencyKey: request.idempotencyKey,
        parent,
        parentEvent: requestedEvent,
        requestHash,
      };
      let admitted = false;
      const parentFence =
        this.#durability === undefined || parent.status === "BROKEN"
          ? undefined
          : this.#requireSessionFence(parent);
      try {
        const childLease = await this.#enqueueDurable(parent.id, 0, () =>
          this.#durability?.createForkSession(
            admission,
            this.#ownerIdentity,
            this.#sessionLeaseMilliseconds,
            parentFence,
          ),
        );
        if (this.#durability !== undefined) {
          if (childLease === undefined) throw missingSessionLease(child);
          this.#sessionLeases.set(child.id, childLease);
        }
        admitted = true;
        this.#checkpoints.set(parent.id, checkpoint);
        this.#checkpointInvalid.delete(parent.id);
        this.store.appendEvent(parent.id, parent.generation, requestedEvent);
        this.store.appendEvent(child.id, child.generation, createdEvent);
        this.store.appendEvent(child.id, child.generation, startingEvent);
        const forkedEvent = this.#eventDraft(
          parent,
          "session.forked",
          {
            checkpointHash: checkpoint.contentHash,
            checkpointVersion: checkpoint.version,
            childSessionId: child.id,
            stale,
          },
          undefined,
          undefined,
          request.actor,
        );
        const ready = await this.#launchSession(child, {
          additionalReadyEvents: [forkedEvent],
          initialCwd: checkpoint.cwd,
          initialEnvironment: checkpoint.filteredEnvironment,
        });
        this.store.appendEvent(parent.id, parent.generation, forkedEvent);
        const result: SessionForkResult = {
          checkpoint: checkpointView(checkpoint, sourceStatus, this.#now()),
          limitations: FORK_LIMITATIONS,
          replayed: false,
          session: ready,
        };
        this.#forkReplays.set(replayScope, { requestHash, result });
        return result;
      } catch (error) {
        if (!admitted) {
          this.#sessionLeases.delete(child.id);
          this.#interactionStates.delete(child.id);
          this.store.deleteSession(child.id, child.generation);
        }
        const failedEvent = this.#event(
          parent,
          "session.fork_failed",
          { childSessionId: child.id, reason: errorMessage(error) },
          { actor: request.actor, persist: false },
        );
        if (this.#durability !== undefined) {
          void this.#enqueueDurable(parent.id, 0, () =>
            parentFence === undefined
              ? this.#durability?.appendOwnerEvent(this.#ownerIdentity, failedEvent)
              : this.#durability?.appendEvent(parentFence, failedEvent),
          ).catch((durableError: unknown) => this.#tripDurability(parent.id, durableError));
        }
        throw error;
      }
    });
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

  public async getTerminalState(
    sessionId: string,
    generation: number,
  ): Promise<TerminalStateObservation> {
    return this.#withMutationLock(sessionId, async () => {
      const screen = await this.getScreen(sessionId, generation);
      const session = this.#requireGeneration(sessionId, generation);
      const execution =
        session.activeExecutionId === undefined
          ? undefined
          : this.store.getExecution(session.activeExecutionId);
      return classifyTerminalState({
        ...(execution === undefined ? {} : { execution }),
        observedAt: this.#timestamp(),
        screen,
        session,
      });
    });
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
    readonly hydratedSessions: number;
    readonly unknownExecutions: number;
  }> {
    try {
      const recovered: DurableOwnerRecoveryResult = (await this.#durability?.recoverOwner(
        this.#ownerIdentity,
        reason,
      )) ?? {
        brokenSessions: 0,
        rebuildableSessions: [],
        unknownExecutions: 0,
      };
      let hydratedSessions = 0;
      this.#sessionLeases.clear();
      for (const rebuildable of recovered.rebuildableSessions) {
        if (!this.#checkpointCompatibleWithRuntime(rebuildable)) continue;
        const existing = this.store.getSession(rebuildable.session.id);
        if (existing === undefined) {
          this.store.createSession(rebuildable.session);
          hydratedSessions += 1;
        } else if (
          existing.generation !== rebuildable.session.generation ||
          existing.status !== "BROKEN"
        ) {
          throw new RuntimeError(
            "DELIVERY_UNKNOWN",
            "Durable rebuild projection conflicts with live Runtime state",
            {
              durableGeneration: rebuildable.session.generation,
              durableStatus: rebuildable.session.status,
              liveGeneration: existing.generation,
              liveStatus: existing.status,
              sessionId: existing.id,
            },
          );
        } else {
          existing.actionSequence = Math.max(
            existing.actionSequence,
            rebuildable.session.actionSequence,
          );
          existing.eventSequence = Math.max(
            existing.eventSequence,
            rebuildable.session.eventSequence,
          );
          existing.screenVersion = Math.max(
            existing.screenVersion,
            rebuildable.session.screenVersion,
          );
        }
        this.#checkpoints.set(rebuildable.session.id, rebuildable.checkpoint);
        this.#checkpointInvalid.delete(rebuildable.session.id);
        const queue = this.#durableQueues.get(rebuildable.session.id);
        if (queue !== undefined) delete queue.failure;
      }
      this.#ownerDurabilityFailure = undefined;
      return {
        brokenSessions: recovered.brokenSessions,
        hydratedSessions,
        unknownExecutions: recovered.unknownExecutions,
      };
    } catch (error) {
      const failure = durabilityError(error);
      this.#tripOwnerDurability(failure);
      throw failure;
    }
  }

  #checkpointCompatibleWithRuntime(rebuildable: DurableRebuildableSession): boolean {
    const { checkpoint, session } = rebuildable;
    if (
      session.ownerId !== this.#ownerId ||
      session.status !== "BROKEN" ||
      session.activeExecutionId !== undefined ||
      checkpoint.sessionId !== session.id ||
      checkpoint.sourceGeneration !== session.generation ||
      checkpoint.shell !== session.shell ||
      checkpoint.workspaceRoot !== session.workspaceRoot ||
      checkpoint.version < 1
    ) {
      return false;
    }
    const allowed = new Set(this.#checkpointEnvironmentKeys);
    for (const [key, value] of Object.entries(checkpoint.filteredEnvironment)) {
      if (
        !allowed.has(key) ||
        value.includes("\0") ||
        value.includes("\n") ||
        Buffer.byteLength(value) > MAX_CHECKPOINT_ENVIRONMENT_VALUE_BYTES
      ) {
        return false;
      }
    }
    return (
      checkpoint.contentHash ===
      hashRequest({
        cwd: checkpoint.cwd,
        filteredEnvironment: checkpoint.filteredEnvironment,
        shell: checkpoint.shell,
        workspaceRoot: checkpoint.workspaceRoot,
      })
    );
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

  public requestExecuteApproval(request: RequestExecuteApprovalRequest): Promise<Approval> {
    return this.#withMutationLock(request.sessionId, async () => {
      this.#requireActorCapability(request.actor, "approval.request");
      if (request.actor.type !== "agent") {
        throw new RuntimeError("POLICY_DENIED", "Only an Agent may request Execute Approval", {
          actorId: request.actor.id,
          actorType: request.actor.type,
        });
      }
      validateExecuteCommand(request.command);
      validateIdempotencyKey(request.actionIdempotencyKey);
      validateIdempotencyKey(request.requestIdempotencyKey);
      const reason = validateApprovalReason(request.reason, "Approval request reason");
      const ttlMilliseconds = validateApprovalTtl(request.ttlMilliseconds);
      await this.#flushDurable(request.sessionId);
      const session = this.#requireGeneration(request.sessionId, request.sessionGeneration);
      this.#requireExecutor(session.id);
      const actionRequestHash = executeApprovalActionRequestHash({
        actor: request.actor,
        command: request.command,
        idempotencyKey: request.actionIdempotencyKey,
        sessionGeneration: request.sessionGeneration,
        sessionId: request.sessionId,
      });
      const requestHash = hashRequest({ actionRequestHash, reason, ttlMilliseconds });
      const replayScope = approvalRequestReplayScope(request);
      const replay = this.#approvalRequestReplays.get(replayScope);
      if (replay !== undefined && this.#durability === undefined) {
        if (replay.requestHash !== requestHash) {
          throw new RuntimeError(
            "IDEMPOTENCY_KEY_REUSED",
            "Approval request idempotency key changed proposal",
            { idempotencyKey: request.requestIdempotencyKey },
          );
        }
        return cloneApproval(this.#requireApproval(replay.approvalId));
      }
      const requestedAt = this.#timestamp();
      const approval: Approval = {
        actionIdempotencyKey: request.actionIdempotencyKey,
        actionRequestHash,
        command: request.command,
        expiresAt: new Date(new Date(requestedAt).getTime() + ttlMilliseconds).toISOString(),
        id: `apr_${randomUUID()}`,
        operation: "execution.start",
        reason,
        requestHash,
        requestIdempotencyKey: request.requestIdempotencyKey,
        requestedAt,
        requester: cloneActor(request.actor),
        sessionGeneration: session.generation,
        sessionId: session.id,
        status: "PENDING",
        version: 1,
      };
      const event = this.#eventDraft(
        session,
        "approval.requested",
        {
          actionRequestHash,
          approvalId: approval.id,
          expiresAt: approval.expiresAt,
          operation: approval.operation,
          reason,
        },
        undefined,
        undefined,
        request.actor,
      );
      let committed = approval;
      let committedEvent = event;
      let replayed = false;
      if (this.#durability !== undefined) {
        try {
          const durable = await this.#enqueueDurable(session.id, 0, () =>
            this.#durability?.requestApproval(this.#requireSessionFence(session), {
              approval,
              event,
            }),
          );
          if (durable === undefined) {
            throw new RuntimeError("RUNTIME_UNAVAILABLE", "Approval request was not persisted");
          }
          committed = durable.approval;
          replayed = durable.replayed;
          committedEvent = {
            ...event,
            observedAt: committed.requestedAt,
            payload: { ...event.payload, expiresAt: committed.expiresAt },
          };
        } catch (error) {
          if (isDurabilityFatal(error)) this.#tripDurability(session.id, error);
          throw error instanceof RuntimeError ? error : durabilityError(error);
        }
      }
      this.#approvals.set(committed.id, committed);
      this.#approvalRequestReplays.set(replayScope, {
        approvalId: committed.id,
        requestHash,
      });
      if (!replayed) this.store.appendEvent(session.id, session.generation, committedEvent);
      return cloneApproval(committed);
    });
  }

  public getApproval(request: GetApprovalRequest): Promise<Approval> {
    return this.#withMutationLock(request.sessionId, async () => {
      await this.#flushDurable(request.sessionId);
      const session = this.#requireGeneration(request.sessionId, request.sessionGeneration);
      const approval =
        this.#durability === undefined
          ? this.#approvalForSession(request.approvalId, session.id, session.generation)
          : await this.#durability.getApproval(session.id, session.generation, request.approvalId);
      this.#approvals.set(approval.id, approval);
      this.#authorizeApprovalRead(request.actor, approval);
      if (this.#durability === undefined) this.#expireApproval(session, approval);
      return cloneApproval(approval);
    });
  }

  public listApprovals(request: ListApprovalsRequest): Promise<readonly Approval[]> {
    return this.#withMutationLock(request.sessionId, async () => {
      await this.#flushDurable(request.sessionId);
      const session = this.#requireGeneration(request.sessionId, request.sessionGeneration);
      this.#validateActor(request.actor);
      if (request.actor.type === "human") {
        this.#requireActorCapability(request.actor, "approval.decide");
      } else if (request.actor.type === "agent") {
        this.#requireActorCapability(request.actor, "approval.request");
      } else {
        throw new RuntimeError("POLICY_DENIED", "Actor cannot inspect Approvals", {
          actorId: request.actor.id,
          actorType: request.actor.type,
        });
      }
      const durableApprovals =
        this.#durability === undefined
          ? undefined
          : await this.#durability.listApprovals(session.id, session.generation);
      if (durableApprovals !== undefined) {
        for (const approval of durableApprovals) this.#approvals.set(approval.id, approval);
      }
      const approvals = [...(durableApprovals ?? this.#approvals.values())]
        .filter(
          (approval) =>
            approval.sessionId === session.id &&
            approval.sessionGeneration === session.generation &&
            (request.actor.type === "human" || sameActor(approval.requester, request.actor)),
        )
        .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
        .slice(0, 100);
      if (this.#durability === undefined) {
        for (const approval of approvals) this.#expireApproval(session, approval);
      }
      return approvals
        .filter((approval) => request.status === undefined || approval.status === request.status)
        .map(cloneApproval);
    });
  }

  public decideApproval(request: DecideApprovalRequest): Promise<Approval> {
    return this.#withMutationLock(request.sessionId, async () => {
      this.#requireActorCapability(request.actor, "approval.decide");
      if (request.actor.type !== "human") {
        throw new RuntimeError("POLICY_DENIED", "Only a Human may decide Execute Approval", {
          actorId: request.actor.id,
          actorType: request.actor.type,
        });
      }
      validateIdempotencyKey(request.idempotencyKey);
      const reason = validateApprovalReason(request.reason, "Approval decision reason");
      validateApprovalDecision(request.decision);
      await this.#flushDurable(request.sessionId);
      const session = this.#requireGeneration(request.sessionId, request.sessionGeneration);
      let approval =
        this.#durability === undefined
          ? this.#approvalForSession(request.approvalId, session.id, session.generation)
          : await this.#durability.getApproval(session.id, session.generation, request.approvalId);
      this.#approvals.set(approval.id, approval);
      if (this.#durability === undefined) this.#expireApproval(session, approval);
      const decisionRequestHash = hashRequest({
        actor: request.actor,
        decision: request.decision,
        reason,
      });
      if (approval.decisionIdempotencyKey !== undefined) {
        if (
          approval.decisionIdempotencyKey === request.idempotencyKey &&
          approval.decisionRequestHash === decisionRequestHash
        ) {
          return cloneApproval(approval);
        }
        throw new RuntimeError(
          "IDEMPOTENCY_KEY_REUSED",
          "Approval already has a different decision",
          { approvalId: approval.id },
        );
      }
      requireApprovalExpectedVersion(approval, request.expectedVersion);
      if (approval.status !== "PENDING") throw approvalChanged(approval);
      const decidedAt = this.#timestamp();
      const decidedVersion = approval.version + 1;
      const event = this.#eventDraft(
        session,
        request.decision === "approve" ? "approval.approved" : "approval.denied",
        {
          approvalId: approval.id,
          decisionReason: reason,
          expiresAt: approval.expiresAt,
          operation: approval.operation,
          version: decidedVersion,
        },
        undefined,
        undefined,
        request.actor,
      );
      if (this.#durability !== undefined) {
        const durable = await this.#enqueueDurable(session.id, 0, () =>
          this.#durability?.decideApproval(this.#requireSessionFence(session), {
            approvalId: approval.id,
            approver: request.actor,
            decidedAt,
            decision: request.decision,
            decisionIdempotencyKey: request.idempotencyKey,
            decisionReason: reason,
            decisionRequestHash,
            event,
            expectedVersion: request.expectedVersion,
            sessionGeneration: session.generation,
            sessionId: session.id,
          }),
        );
        if (durable === undefined) {
          throw new RuntimeError("RUNTIME_UNAVAILABLE", "Approval decision was not persisted");
        }
        approval = durable.approval;
        this.#approvals.set(approval.id, approval);
        if (!durable.replayed) this.store.appendEvent(session.id, session.generation, event);
        return cloneApproval(approval);
      }
      approval.status = request.decision === "approve" ? "APPROVED" : "DENIED";
      approval.version = decidedVersion;
      approval.approver = cloneActor(request.actor);
      approval.decidedAt = decidedAt;
      approval.decisionIdempotencyKey = request.idempotencyKey;
      approval.decisionReason = reason;
      approval.decisionRequestHash = decisionRequestHash;
      this.store.appendEvent(session.id, session.generation, event);
      return cloneApproval(approval);
    });
  }

  public startExecute(request: ExecuteRequest): Promise<StartedExecution> {
    return this.#withMutationLock(request.sessionId, () => this.#startExecuteLocked(request));
  }

  async #startExecuteLocked(request: ExecuteRequest): Promise<StartedExecution> {
    this.#requireActorCapability(request.actor, "session.execute");
    validateExecuteCommand(request.command);
    await this.#flushDurable(request.sessionId);
    const requestHash = executeRequestHash(request);
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
    const sensitiveInput = this.#sensitiveInputs.get(session.id);
    if (sensitiveInput?.status === "ACTIVE") {
      throw new RuntimeError(
        "SENSITIVE_INPUT_ACTIVE",
        "Finish the active sensitive input period before starting another ExecuteAction",
        { sensitiveInputId: sensitiveInput.id, version: sensitiveInput.version },
      );
    }
    this.#requireExecutor(session.id);
    if (request.approvalId !== undefined && this.#durability !== undefined) {
      const durableApproval = await this.#durability.getApproval(
        session.id,
        session.generation,
        request.approvalId,
      );
      this.#approvals.set(durableApproval.id, durableApproval);
    }
    const approval = this.#approvalForExecute(request, session);
    const actionId = `act_${randomUUID()}`;
    const executionId = `exe_${randomUUID()}`;
    const reserved = this.store.reserveSession(session.id, session.generation, executionId);
    const acceptedAt = this.#timestamp();
    const actionSequence = this.store.nextActionSequence(session.id, session.generation);
    const action: ExecuteAction = {
      acceptedAt,
      actionSequence,
      actor: request.actor,
      ...(approval === undefined ? {} : { approvalId: approval.id }),
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
      version: 1,
    };
    const acceptedEvent = this.#eventDraft(reserved, "action.accepted", {}, action, execution);
    const dispatchingEvent = this.#eventDraft(
      reserved,
      "action.dispatching",
      {},
      action,
      execution,
    );
    const approvalConsumption =
      approval === undefined
        ? undefined
        : this.#approvalConsumptionDraft(session, approval, action);
    try {
      if (this.#durability !== undefined) {
        const durable = await this.#enqueueDurable(session.id, 0, () =>
          this.#durability?.acceptExecute(this.#requireSessionFence(session), {
            acceptedEvent,
            action,
            dispatchingEvent,
            execution,
            ...(approvalConsumption === undefined
              ? {}
              : {
                  approvalConsumption: {
                    actionRequestHash: approvalConsumption.actionRequestHash,
                    approvalId: approvalConsumption.approvalId,
                    consumedAt: approvalConsumption.consumedAt,
                    event: approvalConsumption.event,
                  },
                }),
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
    if (approval !== undefined && approvalConsumption !== undefined) {
      this.#consumeApproval(
        approval,
        action,
        approvalConsumption.consumedAt,
        approvalConsumption.event,
      );
    }

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
      writeAccepted: false,
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
          expectedExecutionVersion: execution.version,
          fence: this.#requireSessionFence(session),
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
        onWriteAccepted: () => {
          state.writeAccepted = true;
        },
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
                expectedExecutionVersion: execution.version,
                fence: this.#requireSessionFence(running),
                event: startedEvent,
                execution,
                session: running,
              }),
            ).then(
              () => {
                execution.version += 1;
                state.started.resolve();
              },
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
      void shellCompletion.catch(() => undefined);
      this.#hooks.afterExecutionWrite?.(execution);
    } catch (error) {
      await this.#failDispatchedExecution(state, error);
      throw error;
    }

    const result = shellCompletion.then(
      (completed) => this.#finishDispatchedExecution(state, completed),
      (error: unknown) =>
        execution.status === "RUNNING"
          ? this.#withMutationLock(execution.sessionId, () =>
              this.#failDispatchedExecution(state, error),
            )
          : this.#failDispatchedExecution(state, error),
    );
    void result.then(state.completion.resolve, state.completion.reject);
    await state.started.promise;
  }

  async #finishDispatchedExecution(
    state: ExecutionDispatchState,
    result: ShellExecutionResult,
  ): Promise<Execution> {
    const { action, execution } = state;
    const previousCheckpoint = this.#checkpoints.get(execution.sessionId);
    let checkpoint: ShellCheckpoint | undefined;
    let checkpointRejectedEvent: SessionEvent | undefined;
    try {
      const checkpointSession = this.#requireExactGeneration(
        execution.sessionId,
        execution.sessionGeneration,
      );
      checkpoint = await this.#buildCheckpoint(
        checkpointSession,
        { cwd: result.cwd, filteredEnvironment: result.filteredEnvironment },
        (previousCheckpoint?.version ?? 0) + 1,
      );
    } catch (error) {
      if (!(error instanceof RuntimeError) || error.code !== "CHECKPOINT_INVALID") throw error;
      this.#checkpointInvalid.add(execution.sessionId);
    }
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
    if (checkpoint === undefined) {
      checkpointRejectedEvent = this.#event(
        ready,
        "session.checkpoint_rejected",
        { reason: "cwd_outside_workspace" },
        { persist: false },
      );
    }
    this.#hooks.beforeExecutionFinishPersist?.(execution);
    try {
      await this.#enqueueDurable(execution.sessionId, 0, () =>
        this.#durability?.finishExecution({
          action,
          expectedExecutionVersion: execution.version,
          fence: this.#requireSessionFence(ready),
          ...(checkpoint === undefined ? {} : { checkpoint }),
          events:
            checkpointRejectedEvent === undefined
              ? [completedEvent, readyEvent]
              : [completedEvent, readyEvent, checkpointRejectedEvent],
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
    if (checkpoint !== undefined) {
      this.#checkpoints.set(execution.sessionId, checkpoint);
      this.#checkpointInvalid.delete(execution.sessionId);
    }
    execution.version += 1;
    return execution;
  }

  async #failDispatchedExecution(state: ExecutionDispatchState, error: unknown): Promise<never> {
    const { action, execution } = state;
    if (execution.status === "UNKNOWN") throw error;
    const uncertain = state.writeAccepted || execution.status === "RUNNING";
    const settlementError = uncertain
      ? new RuntimeError(
          "DELIVERY_UNKNOWN",
          "Execution outcome is unknown after the Shell dispatch write",
          { executionId: execution.id, reason: errorMessage(error) },
          false,
        )
      : error;
    state.started.reject(settlementError);
    execution.status = uncertain ? "UNKNOWN" : "FAILED";
    execution.finishedAt = this.#timestamp();
    action.status = uncertain ? "UNKNOWN" : "FAILED";
    const current = this.store.getSession(execution.sessionId);
    if (current?.status !== "CLOSED") {
      this.#clearPtyOutput(execution.sessionId);
      this.#markSensitiveInputUnknown(execution.sessionId);
      this.#detachExecutor(execution.sessionId);
      this.#screens.get(execution.sessionId)?.dispose();
      this.#screens.delete(execution.sessionId);
      const activeExecution = executionVersion(execution);
      const broken = this.store.breakSession(execution.sessionId, execution.sessionGeneration);
      const settlementEvent = this.#event(
        broken,
        uncertain ? "execution.unknown" : "execution.failed",
        { reason: errorMessage(error) },
        { action, execution, persist: false },
      );
      const brokenEvent = this.#event(
        broken,
        "session.broken",
        { reason: errorMessage(error) },
        { persist: false },
      );
      const persisted = await this.#enqueueDurable(execution.sessionId, 0, () =>
        uncertain
          ? this.#durability?.markSessionBroken(
              this.#requireSessionFence(broken),
              broken,
              [settlementEvent, brokenEvent],
              errorMessage(error),
              activeExecution,
            )
          : this.#durability?.failExecution({
              action,
              expectedExecutionVersion: execution.version,
              fence: this.#requireSessionFence(broken),
              events: [settlementEvent, brokenEvent],
              execution,
              reason: errorMessage(error),
              session: broken,
            }),
      ).then(
        () => true,
        (durableError: unknown) => {
          this.#tripDurability(execution.sessionId, durableError);
          return false;
        },
      );
      if (persisted) execution.version += 1;
      this.#sessionLeases.delete(execution.sessionId);
    }
    throw settlementError;
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

  public getInteractionState(sessionId: string, generation: number): Promise<InteractionState> {
    return this.#withMutationLock(sessionId, async () => {
      await this.#flushDurable(sessionId);
      const session = this.#requireGeneration(sessionId, generation);
      const state = cloneInteractionState(await this.#reconcileExpiredGuard(session));
      return session.activeExecutionId === undefined
        ? state
        : { ...state, inputContext: { ...this.#inputContext(session, session.activeExecutionId) } };
    });
  }

  public setInputPolicy(request: SetInputPolicyRequest): Promise<InteractionState> {
    return this.#withMutationLock(request.sessionId, async () => {
      await this.#flushDurable(request.sessionId);
      const session = this.#requireGeneration(request.sessionId, request.sessionGeneration);
      let current = await this.#reconcileExpiredGuard(session);
      this.#requireInteractionStateVersion(current, request.expectedVersion);
      if (!this.#actorHasCapability(request.actor, "interaction.policy.manage")) {
        await this.#rejectInteraction(
          session,
          current,
          request.actor,
          "interaction.policy_denied",
          "Actor lacks interaction.policy.manage capability",
          "policy_change",
          { capability: "interaction.policy.manage" },
        );
      }
      if (request.actor.type !== "human" && request.actor.type !== "system") {
        await this.#rejectInteraction(
          session,
          current,
          request.actor,
          "interaction.policy_denied",
          "Only Human or System may change input policy",
          "policy_change",
        );
      }
      if (current.policy === request.mode) return cloneInteractionState(current);
      const next: InteractionState = {
        policy: request.mode,
        sessionGeneration: current.sessionGeneration,
        sessionId: current.sessionId,
        version: current.version + 1,
      };
      current = await this.#commitInteractionState(
        session,
        current,
        next,
        "interaction.policy_changed",
        {
          from: current.policy,
          to: request.mode,
          ...(current.guard === undefined ? {} : { clearedGuardId: current.guard.id }),
        },
        request.actor,
      );
      return cloneInteractionState(current);
    });
  }

  public acquireInteractionGuard(
    request: AcquireInteractionGuardRequest,
  ): Promise<InteractionState> {
    return this.#withMutationLock(request.sessionId, async () => {
      await this.#flushDurable(request.sessionId);
      const session = this.#requireGeneration(request.sessionId, request.sessionGeneration);
      if (session.status !== "RUNNING") {
        throw new RuntimeError(
          "SESSION_NOT_READY",
          "Interaction Guard requires a RUNNING foreground Execution",
          { sessionStatus: session.status },
        );
      }
      const current = await this.#reconcileExpiredGuard(session);
      this.#requireInteractionStateVersion(current, request.expectedVersion);
      if (!this.#actorHasCapability(request.actor, "interaction.guard.manage")) {
        await this.#rejectInteraction(
          session,
          current,
          request.actor,
          "interaction.policy_denied",
          "Actor lacks interaction.guard.manage capability",
          "guard_acquire",
          { capability: "interaction.guard.manage" },
        );
      }
      if (request.actor.type !== "human" || current.policy !== "human_guarded") {
        await this.#rejectInteraction(
          session,
          current,
          request.actor,
          "interaction.policy_denied",
          "Only Human may acquire a Guard under human_guarded policy",
          "guard_acquire",
        );
      }
      if (current.guard !== undefined) {
        await this.#rejectInteraction(
          session,
          current,
          request.actor,
          "interaction.input_guarded",
          "Another Interaction Guard is active",
          "guard_acquire",
        );
      }
      const ttlMilliseconds = validateGuardTtl(request.ttlMilliseconds);
      const reason = validateGuardReason(request.reason);
      const acquiredAt = this.#now();
      const next: InteractionState = {
        guard: {
          acquiredAt: acquiredAt.toISOString(),
          actor: request.actor,
          expiresAt: new Date(acquiredAt.getTime() + ttlMilliseconds).toISOString(),
          id: `grd_${randomUUID()}`,
          maxRenewals: MAX_INTERACTION_GUARD_RENEWALS,
          reason,
          renewals: 0,
        },
        policy: current.policy,
        sessionGeneration: current.sessionGeneration,
        sessionId: current.sessionId,
        version: current.version + 1,
      };
      return cloneInteractionState(
        await this.#commitInteractionState(
          session,
          current,
          next,
          "interaction.guard_acquired",
          {
            expiresAt: next.guard?.expiresAt,
            guardId: next.guard?.id,
            reason,
            ttlMilliseconds,
          },
          request.actor,
        ),
      );
    });
  }

  public renewInteractionGuard(request: RenewInteractionGuardRequest): Promise<InteractionState> {
    return this.#withMutationLock(request.sessionId, async () => {
      await this.#flushDurable(request.sessionId);
      const session = this.#requireGeneration(request.sessionId, request.sessionGeneration);
      const current = await this.#reconcileExpiredGuard(session);
      this.#requireInteractionStateVersion(current, request.expectedVersion);
      this.#requireActorCapability(request.actor, "interaction.guard.manage");
      const guard = this.#requireCurrentGuard(current, request.guardId);
      this.#requireGuardActor(guard.actor, request.actor);
      if (guard.renewals >= guard.maxRenewals) {
        throw new RuntimeError("POLICY_DENIED", "Interaction Guard renewal limit reached", {
          guardId: guard.id,
          maxRenewals: guard.maxRenewals,
        });
      }
      const ttlMilliseconds = validateGuardTtl(request.ttlMilliseconds);
      const renewalBase = Math.max(this.#now().getTime(), Date.parse(guard.acquiredAt));
      const next: InteractionState = {
        ...current,
        guard: {
          ...guard,
          expiresAt: new Date(renewalBase + ttlMilliseconds).toISOString(),
          renewals: guard.renewals + 1,
        },
        version: current.version + 1,
      };
      return cloneInteractionState(
        await this.#commitInteractionState(
          session,
          current,
          next,
          "interaction.guard_renewed",
          {
            expiresAt: next.guard?.expiresAt,
            guardId: guard.id,
            renewals: next.guard?.renewals,
            ttlMilliseconds,
          },
          request.actor,
        ),
      );
    });
  }

  public releaseInteractionGuard(
    request: ReleaseInteractionGuardRequest,
  ): Promise<InteractionState> {
    return this.#withMutationLock(request.sessionId, async () => {
      await this.#flushDurable(request.sessionId);
      const session = this.#requireGeneration(request.sessionId, request.sessionGeneration);
      const current = await this.#reconcileExpiredGuard(session);
      this.#requireInteractionStateVersion(current, request.expectedVersion);
      this.#requireActorCapability(request.actor, "interaction.guard.manage");
      const guard = this.#requireCurrentGuard(current, request.guardId);
      this.#requireGuardActor(guard.actor, request.actor);
      const next: InteractionState = {
        policy: current.policy,
        sessionGeneration: current.sessionGeneration,
        sessionId: current.sessionId,
        version: current.version + 1,
      };
      return cloneInteractionState(
        await this.#commitInteractionState(
          session,
          current,
          next,
          "interaction.guard_released",
          { guardId: guard.id, reason: guard.reason },
          request.actor,
        ),
      );
    });
  }

  public sendInput(request: InputRequest): Promise<InputAction> {
    return this.#withMutationLock(request.sessionId, () => this.#sendInputLocked(request));
  }

  public beginSecretInput(request: BeginSecretInputRequest): Promise<SecretInputAction> {
    return this.#withMutationLock(request.sessionId, () => this.#beginSecretInputLocked(request));
  }

  async #beginSecretInputLocked(request: BeginSecretInputRequest): Promise<SecretInputAction> {
    if (request.data.length === 0 || request.data.includes("\0")) {
      throw new RuntimeError(
        "INVALID_REQUEST",
        "Secret input must be non-empty and contain no NUL bytes",
      );
    }
    await this.#flushDurable(request.sessionId);
    const requestHash = hashRequest({
      expectedScreenVersion: request.expectedScreenVersion,
      targetExecutionId: request.targetExecutionId,
      type: "secret_input",
    });
    const scope = `${request.sessionId}:${request.actor.id}`;
    const replay = this.#idempotentReplay(scope, request.idempotencyKey, requestHash);
    if (replay !== undefined) {
      if (replay.type !== "secret_input") {
        throw new RuntimeError("IDEMPOTENCY_KEY_REUSED", "Idempotency key changed action type");
      }
      return replay;
    }
    const currentSession = this.#requireGeneration(request.sessionId, request.sessionGeneration);
    const currentSensitiveInput = this.#sensitiveInputs.get(currentSession.id);
    if (currentSensitiveInput?.status === "ACTIVE") {
      throw new RuntimeError(
        "SENSITIVE_INPUT_ACTIVE",
        "Session generation already has an active sensitive input period",
        { sensitiveInputId: currentSensitiveInput.id, version: currentSensitiveInput.version },
      );
    }
    const session = this.#requireInteractionTarget(
      request.sessionId,
      request.sessionGeneration,
      request.targetExecutionId,
      request.expectedScreenVersion,
    );
    await this.#assertInteractionAllowed(session, request.actor, "secret", false);
    const previousInputContext = this.#inputContext(session, request.targetExecutionId);
    const acceptedAt = this.#timestamp();
    const sensitiveInputId = `sec_${randomUUID()}`;
    const action: SecretInputAction = {
      acceptedAt,
      actionSequence: this.store.nextActionSequence(session.id, session.generation),
      actor: request.actor,
      id: `act_${randomUUID()}`,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      sensitiveInputId,
      sessionGeneration: session.generation,
      sessionId: session.id,
      status: "ACCEPTED",
      targetExecutionId: request.targetExecutionId,
      type: "secret_input",
      ...(request.expectedScreenVersion === undefined
        ? {}
        : { expectedScreenVersion: request.expectedScreenVersion }),
    };
    const sensitiveInput: SensitiveInput = {
      actionId: action.id,
      actor: cloneActor(request.actor),
      id: sensitiveInputId,
      sessionGeneration: session.generation,
      sessionId: session.id,
      startedAt: acceptedAt,
      status: "ACTIVE",
      targetExecutionId: request.targetExecutionId,
      version: 1,
    };
    const acceptedEvent = this.#eventDraft(
      session,
      "sensitive_input.started",
      { sensitiveInputId, targetExecutionId: request.targetExecutionId, version: 1 },
      action,
      this.#requireExecution(request.targetExecutionId),
    );
    try {
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.acceptSecretInput(
          this.#requireSessionFence(session),
          action,
          sensitiveInput,
          acceptedEvent,
        ),
      );
    } catch (error) {
      this.store.rollbackActionSequence(session.id, session.generation, action.actionSequence);
      if (isDurabilityFatal(error)) this.#tripDurability(session.id, error);
      throw error instanceof RuntimeError ? error : durabilityError(error);
    }
    this.store.saveAction(action);
    this.store.bindIdempotency(scope, request.idempotencyKey, action.id);
    this.#sensitiveInputs.set(session.id, sensitiveInput);
    this.store.appendEvent(session.id, session.generation, acceptedEvent);
    await this.#recordInteractionWriteAttempt(session, action, {
      interactionType: action.type,
      sensitiveInputId,
    });
    try {
      this.#requireExecutor(session.id).writeSecret(request.data);
      this.#hooks.afterSecretInputWrite?.(action);
      action.status = "DELIVERED";
      const deliveredEvent = this.#event(
        session,
        "sensitive_input.delivered",
        { sensitiveInputId },
        { action, persist: false },
      );
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.finishInteraction(
          this.#requireSessionFence(session),
          action,
          deliveredEvent,
        ),
      );
      this.#completeUntrackedInput(session, action, previousInputContext);
      return action;
    } catch {
      action.status = "UNKNOWN";
      const unknownEvent = this.#event(
        session,
        "sensitive_input.delivery_unknown",
        { sensitiveInputId },
        { action, persist: false },
      );
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.finishInteraction(
          this.#requireSessionFence(session),
          action,
          unknownEvent,
        ),
      ).catch((durableFailure: unknown) => this.#tripDurability(session.id, durableFailure));
      throw new RuntimeError(
        "DELIVERY_UNKNOWN",
        "Secret input delivery is uncertain; output redaction remains active",
        { actionId: action.id, sensitiveInputId },
        false,
      );
    }
  }

  public getSensitiveInput(request: GetSensitiveInputRequest): SensitiveInput | undefined {
    const session = this.#requireGeneration(request.sessionId, request.sessionGeneration);
    this.#requireSecretActor(request.actor);
    const sensitiveInput = this.#sensitiveInputs.get(session.id);
    return sensitiveInput === undefined ? undefined : cloneSensitiveInput(sensitiveInput);
  }

  public finishSensitiveInput(request: FinishSensitiveInputRequest): Promise<SensitiveInput> {
    return this.#withMutationLock(request.sessionId, async () => {
      await this.#flushDurable(request.sessionId);
      const session = this.#requireGeneration(request.sessionId, request.sessionGeneration);
      this.#requireSecretActor(request.actor);
      const sensitiveInput = this.#sensitiveInputs.get(session.id);
      if (sensitiveInput === undefined || sensitiveInput.id !== request.sensitiveInputId) {
        throw new RuntimeError("SENSITIVE_INPUT_CHANGED", "Sensitive input period is not current", {
          sensitiveInputId: request.sensitiveInputId,
        });
      }
      const finishRequestHash = hashRequest({ outcome: request.outcome });
      if (sensitiveInput.status !== "ACTIVE") {
        if (
          sensitiveInput.finishIdempotencyKey === request.idempotencyKey &&
          sensitiveInput.finishRequestHash === finishRequestHash
        ) {
          return cloneSensitiveInput(sensitiveInput);
        }
        throw new RuntimeError("SENSITIVE_INPUT_CHANGED", "Sensitive input period already ended", {
          status: sensitiveInput.status,
          version: sensitiveInput.version,
        });
      }
      if (!sameActor(sensitiveInput.actor, request.actor) && session.status !== "READY") {
        throw new RuntimeError(
          "POLICY_DENIED",
          "Only the Human who started the period may finish it while the Execution is live",
        );
      }
      if (request.expectedVersion !== sensitiveInput.version) {
        throw new RuntimeError("SENSITIVE_INPUT_CHANGED", "Sensitive input version changed", {
          currentVersion: sensitiveInput.version,
          expectedVersion: request.expectedVersion,
        });
      }
      validateIdempotencyKey(request.idempotencyKey);
      const finishedAt = this.#timestamp();
      const next: SensitiveInput = {
        ...sensitiveInput,
        finishIdempotencyKey: request.idempotencyKey,
        finishRequestHash,
        finishedAt,
        status: request.outcome === "completed" ? "COMPLETED" : "CANCELLED",
        version: sensitiveInput.version + 1,
      };
      const event = this.#eventDraft(
        session,
        request.outcome === "completed" ? "sensitive_input.completed" : "sensitive_input.cancelled",
        { sensitiveInputId: next.id, version: next.version },
        undefined,
        this.#requireExecution(next.targetExecutionId),
        request.actor,
      );
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.finishSensitiveInput(this.#requireSessionFence(session), next, event),
      );
      this.#requireExecutor(session.id).finishSensitiveOutput();
      this.#sensitiveInputs.set(session.id, next);
      this.store.appendEvent(session.id, session.generation, event);
      return cloneSensitiveInput(next);
    });
  }

  async #sendInputLocked(
    request: InputRequest,
    terminalResponse?: TerminalCursorResponse,
  ): Promise<InputAction> {
    if (request.data.includes("\0")) {
      throw new RuntimeError("INVALID_REQUEST", "Input data cannot contain NUL bytes");
    }
    if (request.lineInput !== undefined) {
      validateLineInput(request.data, request.lineInput, request.expectedScreenVersion);
    }
    await this.#flushDurable(request.sessionId);
    const requestHash = hashRequest({
      data: request.data,
      expectedScreenVersion: request.expectedScreenVersion,
      targetExecutionId: request.targetExecutionId,
      ...(terminalResponse === undefined ? {} : { terminalResponse }),
      ...(request.lineInput === undefined ? {} : { lineInput: request.lineInput }),
    });
    const scope = `${request.sessionId}:${request.actor.id}`;
    const replay = this.#idempotentReplay(scope, request.idempotencyKey, requestHash);
    if (replay !== undefined) {
      if (replay.type !== "input") {
        throw new RuntimeError("IDEMPOTENCY_KEY_REUSED", "Idempotency key changed action type");
      }
      return replay;
    }
    if (terminalResponse === undefined) {
      this.#assertSensitiveInteraction(
        request.sessionId,
        request.sessionGeneration,
        request.actor,
        "input",
      );
    }
    const session = this.#requireInteractionTarget(
      request.sessionId,
      request.sessionGeneration,
      request.targetExecutionId,
      request.expectedScreenVersion,
    );
    if (terminalResponse === undefined)
      await this.#assertInteractionAllowed(session, request.actor, "input", false);
    const inputContext = this.#inputContext(session, request.targetExecutionId);
    if (request.lineInput !== undefined) {
      const state = this.#requireInteractionState(session.id, session.generation);
      if (
        inputContext.version !== request.lineInput.expectedInputVersion ||
        state.version !== request.lineInput.expectedInteractionVersion
      ) {
        throw new RuntimeError(
          "INPUT_CONTEXT_CHANGED",
          "Input or interaction context changed; re-observe before deciding",
          {
            currentInputVersion: inputContext.version,
            currentInteractionVersion: state.version,
          },
        );
      }
      if (inputContext.state !== "clear") {
        throw new RuntimeError(
          "INPUT_CONTEXT_UNSAFE",
          "Pending or unknown foreground input prevents independent line submission",
          {
            inputState: inputContext.state,
          },
        );
      }
    }
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
      ...(request.lineInput === undefined ? {} : { lineInput: { ...request.lineInput } }),
      ...(terminalResponse === undefined
        ? {}
        : {
            terminalResponse: {
              kind: terminalResponse.kind,
              sourceScreenVersion: terminalResponse.sourceScreenVersion,
            },
          }),
      ...(request.expectedScreenVersion === undefined
        ? {}
        : { expectedScreenVersion: request.expectedScreenVersion }),
    };
    if (terminalResponse !== undefined && !isTerminalResponseAction(action)) {
      this.store.rollbackActionSequence(session.id, session.generation, action.actionSequence);
      throw new RuntimeError("INVALID_REQUEST", "Invalid generated terminal response");
    }
    const acceptedEvent = this.#eventDraft(session, "action.accepted", {}, action);
    try {
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.acceptInteraction(
          this.#requireSessionFence(session),
          action,
          acceptedEvent,
        ),
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
        this.#durability?.finishInteraction(
          this.#requireSessionFence(session),
          action,
          deliveredEvent,
        ),
      );
      if (terminalResponse === undefined) {
        this.#inputContexts.set(session.id, {
          targetExecutionId: action.targetExecutionId,
          version: action.actionSequence,
          state: deliveredInputState(inputContext.state, request.data),
          ...(deliveredInputState(inputContext.state, request.data) !== "unknown"
            ? {}
            : {
                unknownReason:
                  inputContext.state === "unknown"
                    ? (inputContext.unknownReason ?? "delivery")
                    : "untracked_input",
              }),
        });
      }
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
        this.#durability?.finishInteraction(
          this.#requireSessionFence(session),
          action,
          unknownEvent,
        ),
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

  public resizeTerminal(request: ResizeRequest): Promise<ResizeAction> {
    return this.#withMutationLock(request.sessionId, () => this.#resizeTerminalLocked(request));
  }

  async #resizeTerminalLocked(request: ResizeRequest): Promise<ResizeAction> {
    validateTerminalGeometry(request.columns, request.rows);
    if (
      !Number.isSafeInteger(request.expectedGeometryVersion) ||
      request.expectedGeometryVersion < 1
    ) {
      throw new RuntimeError(
        "INVALID_REQUEST",
        "Resize expectedGeometryVersion must be a positive integer",
      );
    }
    await this.#flushDurable(request.sessionId);
    const requestHash = hashRequest({
      columns: request.columns,
      expectedGeometryVersion: request.expectedGeometryVersion,
      rows: request.rows,
    });
    const scope = `${request.sessionId}:${request.actor.id}`;
    const replay = this.#idempotentReplay(scope, request.idempotencyKey, requestHash);
    if (replay !== undefined) {
      if (replay.type !== "resize") {
        throw new RuntimeError("IDEMPOTENCY_KEY_REUSED", "Idempotency key changed action type");
      }
      return replay;
    }
    const session = this.#requireGeneration(request.sessionId, request.sessionGeneration);
    if (session.status === "STARTING") {
      throw new RuntimeError("SESSION_NOT_READY", "Terminal resize requires a ready live PTY", {
        status: session.status,
      });
    }
    const screen = this.#requireScreen(session.id, session.generation);
    const current = await screen.snapshot();
    this.#requireGeneration(session.id, session.generation);
    if (current.geometryVersion !== request.expectedGeometryVersion) {
      throw new RuntimeError(
        "GEOMETRY_CHANGED",
        "Expected terminal geometry version is stale",
        {
          currentColumns: current.columns,
          currentGeometryVersion: current.geometryVersion,
          currentRows: current.rows,
          expectedGeometryVersion: request.expectedGeometryVersion,
        },
        true,
      );
    }
    if (current.columns === request.columns && current.rows === request.rows) {
      throw new RuntimeError("INVALID_REQUEST", "Terminal already has the requested geometry", {
        columns: current.columns,
        geometryVersion: current.geometryVersion,
        rows: current.rows,
      });
    }
    await this.#assertInteractionAllowed(session, request.actor, "resize", false);
    const action: ResizeAction = {
      acceptedAt: this.#timestamp(),
      actionSequence: this.store.nextActionSequence(session.id, session.generation),
      actor: request.actor,
      columns: request.columns,
      expectedGeometryVersion: request.expectedGeometryVersion,
      id: `act_${randomUUID()}`,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      rows: request.rows,
      sessionGeneration: session.generation,
      sessionId: session.id,
      status: "ACCEPTED",
      type: "resize",
    };
    const acceptedEvent = this.#eventDraft(session, "action.accepted", {}, action);
    try {
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.acceptResize(this.#requireSessionFence(session), action, acceptedEvent),
      );
    } catch (error) {
      this.store.rollbackActionSequence(session.id, session.generation, action.actionSequence);
      if (isDurabilityFatal(error)) this.#tripDurability(session.id, error);
      throw error instanceof RuntimeError ? error : durabilityError(error);
    }
    this.store.saveAction(action);
    this.store.bindIdempotency(scope, request.idempotencyKey, action.id);
    this.store.appendEvent(session.id, session.generation, acceptedEvent);

    const attemptedEvent = this.#eventDraft(
      session,
      "terminal.resize_write_attempted",
      {
        columns: action.columns,
        fromColumns: current.columns,
        fromGeometryVersion: current.geometryVersion,
        fromRows: current.rows,
        rows: action.rows,
      },
      action,
    );
    try {
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.markResizeWriteAttempted(
          this.#requireSessionFence(session),
          action,
          attemptedEvent,
        ),
      );
    } catch (error) {
      this.#tripDurability(session.id, error);
      throw durabilityError(error);
    }
    this.store.appendEvent(session.id, session.generation, attemptedEvent);

    const resizeScreenVersion = this.store.bumpScreenVersion(session.id, session.generation);
    let projectionResize: Promise<TerminalScreenSnapshot> | undefined;
    try {
      projectionResize = screen.resize(action.columns, action.rows, resizeScreenVersion);
      this.#requireExecutor(session.id).resize(action.columns, action.rows);
      this.#hooks.afterResizeWrite?.(action);
      const resized = await projectionResize;
      if (
        resized.columns !== action.columns ||
        resized.rows !== action.rows ||
        resized.geometryVersion !== current.geometryVersion + 1 ||
        resized.screenVersion !== resizeScreenVersion
      ) {
        throw new Error("Terminal projection did not converge to the requested geometry");
      }
      action.status = "DELIVERED";
      const deliveredEvent = this.#eventDraft(
        session,
        "terminal.resized",
        {
          columns: resized.columns,
          fromColumns: current.columns,
          fromGeometryVersion: current.geometryVersion,
          fromRows: current.rows,
          geometryVersion: resized.geometryVersion,
          rows: resized.rows,
          screenVersion: resizeScreenVersion,
        },
        action,
      );
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.finishResize({
          action,
          event: deliveredEvent,
          fence: this.#requireSessionFence(session),
          session,
        }),
      );
      this.store.appendEvent(session.id, session.generation, deliveredEvent);
      return action;
    } catch (error) {
      await projectionResize?.catch(() => undefined);
      action.status = "UNKNOWN";
      const activeExecutionState =
        session.activeExecutionId === undefined
          ? undefined
          : this.#requireExecution(session.activeExecutionId);
      const activeExecution =
        activeExecutionState === undefined ? undefined : executionVersion(activeExecutionState);
      const broken = this.store.breakSession(session.id, session.generation);
      const unknownEvent = this.#eventDraft(
        broken,
        "terminal.resize_unknown",
        { reason: errorMessage(error) },
        action,
      );
      const brokenEvent = this.#eventDraft(broken, "session.broken", {
        reason: "Terminal geometry convergence is unknown",
      });
      let persisted = false;
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.finishResize({
          action,
          ...(activeExecution === undefined ? {} : { activeExecution }),
          brokenEvent,
          event: unknownEvent,
          fence: this.#requireSessionFence(broken),
          session: broken,
        }),
      )
        .then(() => {
          persisted = true;
        })
        .catch((durableFailure: unknown) => this.#tripDurability(session.id, durableFailure));
      if (persisted && activeExecutionState !== undefined) activeExecutionState.version += 1;
      this.#sessionLeases.delete(session.id);
      this.store.appendEvent(session.id, session.generation, unknownEvent);
      this.store.appendEvent(session.id, session.generation, brokenEvent);
      this.#breakLiveSession(broken, errorMessage(error));
      throw new RuntimeError(
        "DELIVERY_UNKNOWN",
        "Terminal resize delivery is uncertain; the Session generation is broken",
        { actionId: action.id },
        false,
      );
    }
  }

  async #sendControlLocked(request: ControlRequest): Promise<ControlAction> {
    await this.#flushDurable(request.sessionId);
    const requestHash = hashRequest({
      bypassGuard: request.bypassGuard ?? false,
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
    this.#assertSensitiveInteraction(
      request.sessionId,
      request.sessionGeneration,
      request.actor,
      "control",
    );
    const session = this.#requireInteractionTarget(
      request.sessionId,
      request.sessionGeneration,
      request.targetExecutionId,
    );
    await this.#assertInteractionAllowed(
      session,
      request.actor,
      "control",
      request.bypassGuard ?? false,
    );
    const action: ControlAction = {
      acceptedAt: this.#timestamp(),
      actionSequence: this.store.nextActionSequence(session.id, session.generation),
      actor: request.actor,
      bypassGuard: request.bypassGuard ?? false,
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
    const previousInputContext = this.#inputContext(session, request.targetExecutionId);
    const acceptedEvent = this.#eventDraft(session, "action.accepted", {}, action);
    try {
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.acceptInteraction(
          this.#requireSessionFence(session),
          action,
          acceptedEvent,
        ),
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
        this.#durability?.finishInteraction(
          this.#requireSessionFence(session),
          action,
          deliveredEvent,
        ),
      );
      this.#completeUntrackedInput(session, action, previousInputContext);
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
        this.#durability?.finishInteraction(
          this.#requireSessionFence(session),
          action,
          unknownEvent,
        ),
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
    action: InputAction | SecretInputAction | ControlAction,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (action.type !== "input" || !isTerminalResponseAction(action)) {
      // Stay unknown on any write/durability failure; only proven ordinary delivery refines it.
      this.#inputContexts.set(session.id, {
        targetExecutionId: action.targetExecutionId,
        version: action.actionSequence,
        state: "unknown",
        unknownReason: "delivery",
      });
    }
    const event = this.#eventDraft(
      session,
      "interaction.write_attempted",
      payload,
      action,
      this.#requireExecution(action.targetExecutionId),
    );
    try {
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.markInteractionWriteAttempted(
          this.#requireSessionFence(session),
          action,
          event,
        ),
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
    this.#requireExactGeneration(sessionId, generation);
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
      const activeExecutionState =
        session.activeExecutionId === undefined
          ? undefined
          : this.#requireExecution(session.activeExecutionId);
      const activeExecution =
        activeExecutionState === undefined ? undefined : executionVersion(activeExecutionState);
      this.#markActiveDispatchUnknown(session, "Session closed before Execution outcome");
      this.#markSensitiveInputUnknown(sessionId);
      this.#detachExecutor(sessionId);
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
          this.#durability?.closeSession(
            this.#requireSessionFence(closed),
            closed,
            closedEvent,
            activeExecution,
          ),
        );
        if (activeExecutionState !== undefined) activeExecutionState.version += 1;
        this.#sessionLeases.delete(sessionId);
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
    const execution =
      current.activeExecutionId === undefined
        ? undefined
        : this.store.getExecution(current.activeExecutionId);
    const action = execution === undefined ? undefined : this.store.getAction(execution.actionId);
    this.#screens.get(sessionId)?.write(data, screenVersion, (response) => {
      if (execution !== undefined)
        this.#queueTerminalResponse(sessionId, generation, execution.id, response);
    });
    this.#appendPtyOutput(current, data, screenVersion, action, execution);
  }

  #queueTerminalResponse(
    sessionId: string,
    generation: number,
    executionId: string,
    response: TerminalCursorResponse,
  ): void {
    const current = this.store.getSession(sessionId);
    if (
      current?.generation !== generation ||
      current.status !== "RUNNING" ||
      current.activeExecutionId !== executionId
    )
      return;
    const now = Date.now();
    const budget = this.#terminalResponseBudgets.get(sessionId) ?? {
      pending: 0,
      count: 0,
      since: now,
    };
    if (now - budget.since >= 1_000) {
      budget.count = 0;
      budget.since = now;
    }
    if (budget.pending >= 32 || budget.count >= 120) {
      this.#tripDurability(
        sessionId,
        new RuntimeError("BACKPRESSURE", "Terminal response budget exhausted"),
      );
      return;
    }
    budget.pending += 1;
    budget.count += 1;
    this.#terminalResponseBudgets.set(sessionId, budget);
    void this.#withMutationLock(sessionId, async () => {
      const live = this.store.getSession(sessionId);
      if (
        live?.generation !== generation ||
        live.status !== "RUNNING" ||
        live.activeExecutionId !== executionId
      )
        return;
      await this.#sendInputLocked(
        {
          actor: TERMINAL_RESPONSE_ACTOR,
          data: response.data,
          idempotencyKey: `terminal-response-${randomUUID()}`,
          sessionGeneration: generation,
          sessionId,
          targetExecutionId: executionId,
        },
        response,
      );
    })
      .catch((error: unknown) => {
        const live = this.store.getSession(sessionId);
        if (
          live?.generation === generation &&
          live.status === "RUNNING" &&
          live.activeExecutionId === executionId
        )
          this.#tripDurability(sessionId, error);
      })
      .finally(() => {
        budget.pending -= 1;
        if (budget.pending === 0 && this.store.getSession(sessionId)?.status !== "RUNNING")
          this.#terminalResponseBudgets.delete(sessionId);
      });
  }

  #launchSession(
    session: Session,
    options: Readonly<{
      additionalReadyEvents?: readonly DurableSessionEvent[];
      initialCwd?: string;
      initialEnvironment?: Readonly<Record<string, string>>;
    }> = {},
  ): Promise<Session> {
    return this.#withMutationLock(session.id, () => this.#launchSessionLocked(session, options));
  }

  async #launchSessionLocked(
    session: Session,
    options: Readonly<{
      additionalReadyEvents?: readonly DurableSessionEvent[];
      initialCwd?: string;
      initialEnvironment?: Readonly<Record<string, string>>;
    }>,
  ): Promise<Session> {
    const { generation, id: sessionId } = session;
    const executorId = `executor_${randomUUID()}`;
    let startupLifecycle: ShellExecutorLifecycleEvent | undefined;
    try {
      const screen = this.#screenProjectionFactory?.create({
        sessionGeneration: generation,
        sessionId,
      });
      if (screen !== undefined) this.#screens.set(sessionId, screen);
      const executor = await this.executorFactory.create({
        checkpointEnvironmentKeys: this.#checkpointEnvironmentKeys,
        executorId,
        ...(options.initialCwd === undefined ? {} : { initialCwd: options.initialCwd }),
        ...(options.initialEnvironment === undefined
          ? {}
          : { initialEnvironment: options.initialEnvironment }),
        onLifecycle: (event) => {
          startupLifecycle ??= event;
          this.#queueExecutorLifecycle(event);
        },
        onOutput: (data) => this.#recordOutput(sessionId, generation, data),
        shell: session.shell,
        sessionGeneration: generation,
        sessionId,
        workspaceRoot: session.workspaceRoot,
      });
      if (startupLifecycle !== undefined) {
        executor.close();
        throw new Error("Shell Executor exited before Session startup completed");
      }
      this.#executors.set(sessionId, executor);
      this.#executorIdentities.set(sessionId, { executorId, generation });
      const checkpoint = await this.#buildCheckpoint(session, executor.checkpoint(), 1);
      this.#checkpoints.set(sessionId, checkpoint);
      this.#checkpointInvalid.delete(sessionId);
      const ready = this.store.markSessionReady(sessionId, generation);
      const readyEvent = this.#event(
        ready,
        "session.shell_ready",
        {
          checkpointHash: checkpoint.contentHash,
          checkpointVersion: checkpoint.version,
          shellPid: executor.shellPid,
        },
        { persist: false },
      );
      try {
        await this.#enqueueDurable(session.id, 0, () =>
          this.#durability?.markSessionReady(
            this.#requireSessionFence(ready),
            ready,
            executor.shellPid,
            readyEvent,
            checkpoint,
            options.additionalReadyEvents,
          ),
        );
      } catch (error) {
        if (isDurabilityFatal(error)) this.#tripDurability(sessionId, error);
        throw error;
      }
      return ready;
    } catch (error) {
      this.#detachExecutor(sessionId, executorId);
      this.#screens.get(sessionId)?.dispose();
      this.#screens.delete(sessionId);
      this.#checkpoints.delete(sessionId);
      this.#checkpointInvalid.delete(sessionId);
      const broken = this.store.breakSession(sessionId, generation);
      const brokenEvent = this.#event(
        broken,
        "session.broken",
        { reason: errorMessage(error) },
        { persist: false },
      );
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.markSessionBroken(
          this.#requireSessionFence(broken),
          broken,
          [brokenEvent],
          errorMessage(error),
        ),
      ).catch((durableError: unknown) => this.#tripDurability(session.id, durableError));
      this.#sessionLeases.delete(session.id);
      throw error;
    }
  }

  async #buildCheckpoint(
    session: Session,
    observation: Readonly<{
      cwd: string;
      filteredEnvironment: Readonly<Record<string, string>>;
    }>,
    version: number,
  ): Promise<ShellCheckpoint> {
    const workspaceRoot = await canonicalWorkspace(session.workspaceRoot).catch(
      (error: unknown) => {
        throw new RuntimeError(
          "CHECKPOINT_INVALID",
          "Checkpoint workspace no longer resolves to a directory",
          { reason: errorMessage(error), sessionId: session.id },
        );
      },
    );
    const cwd = await canonicalCheckpointCwd(workspaceRoot, observation.cwd);
    const filteredEnvironment: Record<string, string> = {};
    for (const key of this.#checkpointEnvironmentKeys) {
      const value = observation.filteredEnvironment[key];
      if (value === undefined) continue;
      if (
        value.includes("\0") ||
        value.includes("\n") ||
        Buffer.byteLength(value) > MAX_CHECKPOINT_ENVIRONMENT_VALUE_BYTES
      ) {
        throw new RuntimeError(
          "CHECKPOINT_INVALID",
          `Checkpoint environment value for ${key} is outside the bounded policy`,
          { environmentKey: key, sessionId: session.id },
        );
      }
      filteredEnvironment[key] = value;
    }
    const contentHash = hashRequest({
      cwd,
      filteredEnvironment,
      shell: session.shell,
      workspaceRoot,
    });
    return {
      contentHash,
      cwd,
      filteredEnvironment,
      observedAt: this.#timestamp(),
      sessionId: session.id,
      shell: session.shell,
      sourceGeneration: session.generation,
      version,
      workspaceRoot,
    };
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

  #completeUntrackedInput(
    session: Session,
    action: SecretInputAction | ControlAction,
    previous: InputContext,
  ): void {
    this.#inputContexts.set(session.id, {
      targetExecutionId: action.targetExecutionId,
      version: action.actionSequence,
      state: "unknown",
      unknownReason:
        previous.state === "unknown" && previous.unknownReason !== "untracked_input"
          ? "delivery"
          : "untracked_input",
    });
  }

  #inputContext(session: Session, targetExecutionId: string): InputContext {
    const current = this.#inputContexts.get(session.id);
    return current?.targetExecutionId === targetExecutionId
      ? current
      : { targetExecutionId, version: 0, state: "clear" };
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

  async #assertInteractionAllowed(
    session: Session,
    actor: Actor,
    interactionType: "input" | "secret" | "control" | "resize",
    bypassGuard: boolean,
  ): Promise<void> {
    const state = await this.#reconcileExpiredGuard(session);
    const capability: ActorCapability =
      interactionType === "secret"
        ? "secret.input"
        : interactionType === "input"
          ? "terminal.input"
          : interactionType === "control"
            ? "terminal.control"
            : "terminal.resize";
    if (!this.#actorHasCapability(actor, capability)) {
      await this.#rejectInteraction(
        session,
        state,
        actor,
        "interaction.policy_denied",
        `Actor lacks ${capability} capability`,
        interactionType,
        { capability },
      );
    }
    if (interactionType === "secret" && actor.type !== "human") {
      await this.#rejectInteraction(
        session,
        state,
        actor,
        "interaction.policy_denied",
        "Secret input is Human-only",
        interactionType,
      );
    }
    if (bypassGuard && actor.type !== "human") {
      await this.#rejectInteraction(
        session,
        state,
        actor,
        "interaction.policy_denied",
        "Only Human Control may request Guard bypass",
        interactionType,
      );
    }
    const policyAllows =
      (state.policy === "common" && (actor.type === "human" || actor.type === "agent")) ||
      (state.policy === "human_guarded" && (actor.type === "human" || actor.type === "agent")) ||
      (state.policy === "human_only" && actor.type === "human") ||
      (state.policy === "agent_only" && actor.type === "agent");
    if (!policyAllows) {
      await this.#rejectInteraction(
        session,
        state,
        actor,
        "interaction.policy_denied",
        `Actor type ${actor.type} cannot ${interactionType} under ${state.policy}`,
        interactionType,
      );
    }
    if (
      state.policy === "human_guarded" &&
      state.guard !== undefined &&
      !sameActor(state.guard.actor, actor) &&
      !(interactionType === "control" && bypassGuard && actor.type === "human")
    ) {
      await this.#rejectInteraction(
        session,
        state,
        actor,
        "interaction.input_guarded",
        "Interaction is protected by an active Human Guard",
        interactionType,
      );
    }
  }

  #actorHasCapability(actor: Actor, capability: ActorCapability): boolean {
    this.#validateActor(actor);
    return actorHasCapability(actor, capability);
  }

  #requireSecretActor(actor: Actor): void {
    this.#requireActorCapability(actor, "secret.input");
    if (actor.type !== "human") {
      throw new RuntimeError("POLICY_DENIED", "Secret input is Human-only", {
        actorId: actor.id,
        actorType: actor.type,
      });
    }
  }

  #assertSensitiveInteraction(
    sessionId: string,
    generation: number,
    actor: Actor,
    interactionType: "input" | "control",
  ): void {
    this.#requireGeneration(sessionId, generation);
    const sensitiveInput = this.#sensitiveInputs.get(sessionId);
    if (sensitiveInput?.status !== "ACTIVE") return;
    if (
      interactionType === "control" &&
      actor.type === "human" &&
      sameActor(sensitiveInput.actor, actor)
    ) {
      return;
    }
    throw new RuntimeError(
      "SENSITIVE_INPUT_ACTIVE",
      "Ordinary input is blocked during the Human sensitive input period",
      { sensitiveInputId: sensitiveInput.id, version: sensitiveInput.version },
    );
  }

  #approvalForExecute(request: ExecuteRequest, session: Session): Approval | undefined {
    if (request.actor.type !== "agent") {
      if (request.approvalId !== undefined) {
        throw new RuntimeError("POLICY_DENIED", "Only an Agent Execute may consume Approval", {
          actorId: request.actor.id,
          actorType: request.actor.type,
        });
      }
      return undefined;
    }
    if (request.approvalId === undefined) {
      if (this.#agentExecuteApproval === "required") {
        throw new RuntimeError(
          "APPROVAL_REQUIRED",
          "Agent Execute requires Human Approval",
          { operation: "execution.start", sessionId: session.id },
          true,
        );
      }
      return undefined;
    }
    const approval = this.#approvalForSession(request.approvalId, session.id, session.generation);
    this.#expireApproval(session, approval);
    const actionRequestHash = executeApprovalActionRequestHash(request);
    if (
      approval.status !== "APPROVED" ||
      !sameActor(approval.requester, request.actor) ||
      approval.actionRequestHash !== actionRequestHash
    ) {
      throw approvalRequired(approval);
    }
    return approval;
  }

  #approvalForSession(approvalId: string, sessionId: string, generation: number): Approval {
    if (approvalId.length < 1 || approvalId.length > 256 || approvalId.includes("\0")) {
      throw new RuntimeError("INVALID_REQUEST", "Approval id is invalid");
    }
    const approval = this.#approvals.get(approvalId);
    if (
      approval === undefined ||
      approval.sessionId !== sessionId ||
      approval.sessionGeneration !== generation
    ) {
      throw new RuntimeError("APPROVAL_NOT_FOUND", "Approval not found", {
        approvalId,
        generation,
        sessionId,
      });
    }
    return approval;
  }

  #requireApproval(approvalId: string): Approval {
    const approval = this.#approvals.get(approvalId);
    if (approval === undefined) {
      throw new RuntimeError("APPROVAL_NOT_FOUND", "Approval not found", { approvalId });
    }
    return approval;
  }

  #authorizeApprovalRead(actor: Actor, approval: Approval): void {
    this.#validateActor(actor);
    if (actor.type === "human") {
      this.#requireActorCapability(actor, "approval.decide");
      return;
    }
    if (actor.type === "agent" && sameActor(actor, approval.requester)) {
      this.#requireActorCapability(actor, "approval.request");
      return;
    }
    throw new RuntimeError("POLICY_DENIED", "Actor cannot inspect this Approval", {
      actorId: actor.id,
      approvalId: approval.id,
    });
  }

  #expireApproval(session: Session, approval: Approval): void {
    if (
      (approval.status !== "PENDING" && approval.status !== "APPROVED") ||
      new Date(approval.expiresAt).getTime() > this.#now().getTime()
    ) {
      return;
    }
    approval.status = "EXPIRED";
    approval.version += 1;
    const event = this.#eventDraft(
      session,
      "approval.expired",
      {
        approvalId: approval.id,
        expiresAt: approval.expiresAt,
        operation: approval.operation,
        version: approval.version,
      },
      undefined,
      undefined,
      approval.requester,
    );
    this.store.appendEvent(session.id, session.generation, event);
  }

  #approvalConsumptionDraft(
    session: Session,
    approval: Approval,
    action: ExecuteAction,
  ): Readonly<{
    actionRequestHash: string;
    approvalId: string;
    consumedAt: string;
    event: Omit<SessionEvent, "sequence">;
  }> {
    const consumedAt = this.#timestamp();
    const event = this.#eventDraft(
      session,
      "approval.consumed",
      {
        actionId: action.id,
        approvalId: approval.id,
        operation: approval.operation,
        version: approval.version + 1,
      },
      action,
      undefined,
      action.actor,
    );
    return {
      actionRequestHash: approval.actionRequestHash,
      approvalId: approval.id,
      consumedAt,
      event,
    };
  }

  #consumeApproval(
    approval: Approval,
    action: ExecuteAction,
    consumedAt: string,
    event: Omit<SessionEvent, "sequence">,
  ): void {
    if (approval.status !== "APPROVED") throw approvalRequired(approval);
    approval.status = "CONSUMED";
    approval.version += 1;
    approval.consumedActionId = action.id;
    approval.consumedAt = consumedAt;
    this.store.appendEvent(approval.sessionId, approval.sessionGeneration, event);
  }

  #requireActorCapability(actor: Actor, capability: ActorCapability): void {
    if (!this.#actorHasCapability(actor, capability)) {
      throw new RuntimeError("POLICY_DENIED", `Actor lacks ${capability} capability`, {
        actorId: actor.id,
        capability,
      });
    }
  }

  #validateActor(actor: Actor): void {
    if (!isCanonicalActorCapabilities(actor.capabilities)) {
      throw new RuntimeError(
        "INVALID_REQUEST",
        "Actor capabilities must be a non-empty canonical set",
        { actorId: actor.id },
      );
    }
    const existing = this.#actors.get(actor.id);
    if (existing !== undefined && !sameActor(existing, actor)) {
      throw new RuntimeError(
        "ACTOR_IDENTITY_CONFLICT",
        "Actor id is already bound to a different immutable identity",
        { actorId: actor.id },
      );
    }
    this.#actors.set(actor.id, { ...actor, capabilities: [...actor.capabilities] });
  }

  #requireInteractionStateVersion(state: InteractionState, expectedVersion: number): void {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new RuntimeError(
        "INVALID_REQUEST",
        "Interaction expectedVersion must be a positive integer",
        { expectedVersion },
      );
    }
    if (state.version !== expectedVersion) {
      throw new RuntimeError(
        "INTERACTION_GUARD_CHANGED",
        "Interaction state version changed",
        { currentVersion: state.version, expectedVersion },
        true,
      );
    }
  }

  #requireCurrentGuard(state: InteractionState, guardId: string): InteractionGuard {
    if (guardId.length === 0 || guardId.length > 256) {
      throw new RuntimeError("INVALID_REQUEST", "Interaction guardId is invalid");
    }
    if (state.guard === undefined || state.guard.id !== guardId) {
      throw new RuntimeError(
        "INTERACTION_GUARD_CHANGED",
        "Interaction Guard is no longer current",
        { currentGuardId: state.guard?.id, guardId, stateVersion: state.version },
        true,
      );
    }
    return state.guard;
  }

  #requireGuardActor(holder: Actor, actor: Actor): void {
    if (!sameActor(holder, actor)) {
      throw new RuntimeError(
        "POLICY_DENIED",
        "Only the exact Interaction Guard holder may renew or release it",
        { guardActorId: holder.id },
      );
    }
  }

  async #reconcileExpiredGuard(session: Session): Promise<InteractionState> {
    const current = this.#requireInteractionState(session.id, session.generation);
    if (
      current.guard === undefined ||
      Date.parse(current.guard.expiresAt) > this.#now().getTime()
    ) {
      return current;
    }
    const next: InteractionState = {
      policy: current.policy,
      sessionGeneration: current.sessionGeneration,
      sessionId: current.sessionId,
      version: current.version + 1,
    };
    return this.#commitInteractionState(session, current, next, "interaction.guard_expired", {
      expiredAt: current.guard.expiresAt,
      guardActorId: current.guard.actor.id,
      guardId: current.guard.id,
    });
  }

  #requireInteractionState(sessionId: string, generation: number): InteractionState {
    const state = this.#interactionStates.get(sessionId);
    if (state === undefined || state.sessionGeneration !== generation) {
      throw new RuntimeError(
        "RUNTIME_UNAVAILABLE",
        "Live Interaction state is unavailable for this Session generation",
        { generation, sessionId },
      );
    }
    return state;
  }

  async #commitInteractionState(
    session: Session,
    current: InteractionState,
    next: InteractionState,
    type: string,
    payload: Readonly<Record<string, unknown>>,
    actor?: Actor,
  ): Promise<InteractionState> {
    const event = this.#eventDraft(session, type, payload, undefined, undefined, actor);
    try {
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.saveInteractionState(
          this.#requireSessionFence(session),
          next,
          current.version,
          event,
        ),
      );
    } catch (error) {
      if (isDurabilityFatal(error)) this.#tripDurability(session.id, error);
      throw error instanceof RuntimeError ? error : durabilityError(error);
    }
    this.#interactionStates.set(session.id, next);
    this.store.appendEvent(session.id, session.generation, event);
    return next;
  }

  async #rejectInteraction(
    session: Session,
    state: InteractionState,
    actor: Actor,
    eventType: "interaction.input_guarded" | "interaction.policy_denied",
    message: string,
    interactionType: string,
    details: Readonly<Record<string, unknown>> = {},
  ): Promise<never> {
    const event = this.#eventDraft(
      session,
      eventType,
      {
        interactionType,
        policy: state.policy,
        reason: message,
        stateVersion: state.version,
        ...details,
        ...(state.guard === undefined
          ? {}
          : {
              guardActorId: state.guard.actor.id,
              guardExpiresAt: state.guard.expiresAt,
              guardId: state.guard.id,
            }),
      },
      undefined,
      undefined,
      actor,
    );
    try {
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.appendEvent(this.#requireSessionFence(session), event),
      );
    } catch (error) {
      if (isDurabilityFatal(error)) this.#tripDurability(session.id, error);
      throw durabilityError(error);
    }
    this.store.appendEvent(session.id, session.generation, event);
    if (eventType === "interaction.input_guarded") {
      throw new RuntimeError(
        "INPUT_GUARDED",
        message,
        {
          expiresAt: state.guard?.expiresAt,
          guardActorId: state.guard?.actor.id,
          guardId: state.guard?.id,
          interactionStateVersion: state.version,
          policy: state.policy,
        },
        true,
      );
    }
    throw new RuntimeError(
      "POLICY_DENIED",
      message,
      { interactionStateVersion: state.version, policy: state.policy, ...details },
      false,
    );
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
    if (error instanceof RuntimeError) return error;
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
    this.#flushPtyOutput(session.id);
    const draft = this.#eventDraft(
      session,
      type,
      payload,
      options.action,
      options.execution,
      options.actor,
    );
    return this.#storeAndPersistEvent(session, draft, options.persist !== false, 0);
  }

  #appendPtyOutput(
    session: Session,
    data: string,
    screenVersion: number,
    action: SessionAction | undefined,
    execution: Execution | undefined,
  ): void {
    const observedAt = this.#timestamp();
    let offset = 0;
    while (offset < data.length) {
      let buffer = this.#ptyOutputBuffers.get(session.id);
      if (
        buffer !== undefined &&
        (buffer.generation !== session.generation ||
          buffer.actionId !== action?.id ||
          buffer.executionId !== execution?.id)
      ) {
        this.#flushPtyOutput(session.id);
        buffer = undefined;
      }
      if (buffer === undefined) {
        buffer = this.#newPtyOutputBuffer(session, observedAt, screenVersion, action, execution);
        this.#ptyOutputBuffers.set(session.id, buffer);
      }
      const availableBytes = MAX_PTY_OUTPUT_EVENT_BYTES - buffer.byteLength;
      const chunk = utf8Prefix(data, offset, availableBytes);
      if (chunk.codeUnits === 0) {
        this.#flushPtyOutput(session.id);
        continue;
      }
      buffer.data += data.slice(offset, offset + chunk.codeUnits);
      buffer.byteLength += chunk.byteLength;
      buffer.screenVersion = screenVersion;
      offset += chunk.codeUnits;
      if (buffer.byteLength === MAX_PTY_OUTPUT_EVENT_BYTES) {
        this.#flushPtyOutput(session.id);
      }
    }
  }

  #newPtyOutputBuffer(
    session: Session,
    observedAt: string,
    screenVersion: number,
    action: SessionAction | undefined,
    execution: Execution | undefined,
  ): PtyOutputBuffer {
    const timer = setTimeout(() => {
      try {
        this.#flushPtyOutput(session.id);
      } catch (error) {
        this.#tripDurability(session.id, error);
      }
    }, PTY_OUTPUT_FLUSH_MILLISECONDS);
    timer.unref();
    return {
      byteLength: 0,
      data: "",
      generation: session.generation,
      observedAt,
      screenVersion,
      timer,
      ...(action === undefined ? {} : { actionId: action.id, actor: cloneActor(action.actor) }),
      ...(execution === undefined ? {} : { executionId: execution.id }),
    };
  }

  #flushPtyOutput(sessionId: string): void {
    const buffer = this.#ptyOutputBuffers.get(sessionId);
    if (buffer === undefined) return;
    this.#ptyOutputBuffers.delete(sessionId);
    clearTimeout(buffer.timer);
    const session = this.store.getSession(sessionId);
    if (session === undefined || session.generation !== buffer.generation) {
      throw new RuntimeError(
        "RUNTIME_UNAVAILABLE",
        "PTY output accumulator crossed a Session generation boundary",
        { bufferedGeneration: buffer.generation, sessionId },
        false,
      );
    }
    const draft: DurableSessionEvent = {
      id: `evt_${randomUUID()}`,
      observedAt: buffer.observedAt,
      payload: {
        byteLength: buffer.byteLength,
        data: buffer.data,
        screenVersion: buffer.screenVersion,
      },
      sessionGeneration: buffer.generation,
      sessionId,
      type: "terminal.pty_output",
      ...(buffer.actionId === undefined ? {} : { actionId: buffer.actionId }),
      ...(buffer.actor === undefined ? {} : { actor: buffer.actor }),
      ...(buffer.executionId === undefined ? {} : { executionId: buffer.executionId }),
    };
    this.#storeAndPersistEvent(session, draft, true, buffer.byteLength);
  }

  #storeAndPersistEvent(
    session: Session,
    draft: DurableSessionEvent,
    persist: boolean,
    pendingBytes: number,
  ): SessionEvent {
    const stored = this.store.appendEvent(session.id, session.generation, draft);
    if (persist && this.#durability !== undefined) {
      void this.#enqueueDurable(session.id, pendingBytes, () =>
        this.#durability?.appendEvent(this.#requireSessionFence(session), draft),
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
    actor?: Actor,
  ): DurableSessionEvent {
    return {
      id: `evt_${randomUUID()}`,
      observedAt: this.#timestamp(),
      payload,
      sessionGeneration: session.generation,
      sessionId: session.id,
      type,
      ...(action === undefined
        ? actor === undefined
          ? {}
          : { actor }
        : { actionId: action.id, actor: action.actor }),
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
    this.#flushPtyOutput(sessionId);
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
    this.#sessionLeases.delete(sessionId);
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
    this.#sessionLeases.clear();
  }

  #breakLiveSession(session: Session, reason: string): void {
    this.#clearPtyOutput(session.id);
    this.#markActiveDispatchUnknown(session, reason);
    this.#markSensitiveInputUnknown(session.id);
    this.#detachExecutor(session.id);
    this.#screens.get(session.id)?.dispose();
    this.#screens.delete(session.id);
    if (session.status !== "CLOSED" && session.status !== "BROKEN") {
      this.store.breakSession(session.id, session.generation);
    }
  }

  #clearPtyOutput(sessionId: string): void {
    const buffer = this.#ptyOutputBuffers.get(sessionId);
    if (buffer === undefined) return;
    this.#ptyOutputBuffers.delete(sessionId);
    clearTimeout(buffer.timer);
  }

  #markSensitiveInputUnknown(sessionId: string): void {
    const sensitiveInput = this.#sensitiveInputs.get(sessionId);
    if (sensitiveInput?.status !== "ACTIVE") return;
    sensitiveInput.status = "UNKNOWN";
    sensitiveInput.version += 1;
    sensitiveInput.finishedAt = this.#timestamp();
  }

  #requireOwnerDurability(): void {
    if (this.#ownerDurabilityFailure !== undefined) throw this.#ownerDurabilityFailure;
  }

  #requireSessionFence(session: Pick<Session, "generation" | "id" | "ownerId">): SessionFence {
    const lease = this.#sessionLeases.get(session.id);
    if (
      lease === undefined ||
      lease.generation !== session.generation ||
      lease.ownerId !== session.ownerId
    ) {
      throw missingSessionLease(session);
    }
    return lease;
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

  #queueExecutorLifecycle(event: ShellExecutorLifecycleEvent): void {
    void this.#withMutationLock(event.sessionId, () => this.#handleExecutorLifecycle(event)).catch(
      (error: unknown) => this.#tripDurability(event.sessionId, error),
    );
  }

  async #handleExecutorLifecycle(event: ShellExecutorLifecycleEvent): Promise<void> {
    const identity = this.#executorIdentities.get(event.sessionId);
    if (
      identity === undefined ||
      identity.executorId !== event.executorId ||
      identity.generation !== event.sessionGeneration
    ) {
      return;
    }
    const session = this.store.getSession(event.sessionId);
    if (session === undefined || session.generation !== event.sessionGeneration) return;

    await this.#flushDurable(event.sessionId);
    this.#detachExecutor(event.sessionId, event.executorId);
    this.#screens.get(event.sessionId)?.dispose();
    this.#screens.delete(event.sessionId);
    this.#markSensitiveInputUnknown(event.sessionId);
    if (session.status === "CLOSED" || session.status === "BROKEN") return;

    const activeExecutionState =
      session.activeExecutionId === undefined
        ? undefined
        : this.store.getExecution(session.activeExecutionId);
    const activeExecution =
      activeExecutionState === undefined || isExecutionTerminal(activeExecutionState.status)
        ? undefined
        : executionVersion(activeExecutionState);
    const reason =
      event.reason === "shell_process_exit"
        ? "Persistent Shell process exited"
        : "Shell Executor failed";
    this.#markActiveDispatchUnknown(session, reason);
    const broken = this.store.breakSession(session.id, session.generation);
    const lifecyclePayload = {
      reason: event.reason,
      ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
      ...(event.signal === undefined ? {} : { signal: event.signal }),
    };
    const events: DurableSessionEvent[] = [];
    if (activeExecutionState !== undefined && activeExecution !== undefined) {
      events.push(
        this.#eventDraft(
          broken,
          "execution.unknown",
          lifecyclePayload,
          this.store.getAction(activeExecutionState.actionId),
          activeExecutionState,
        ),
      );
    }
    events.push(this.#eventDraft(broken, "session.broken", lifecyclePayload));
    try {
      await this.#enqueueDurable(session.id, 0, () =>
        this.#durability?.markSessionBroken(
          this.#requireSessionFence(broken),
          broken,
          events,
          reason,
          activeExecution,
        ),
      );
      if (activeExecutionState !== undefined && activeExecution !== undefined) {
        activeExecutionState.version += 1;
      }
      for (const lifecycleEvent of events) {
        this.store.appendEvent(session.id, session.generation, lifecycleEvent);
      }
      this.#sessionLeases.delete(session.id);
    } catch (error) {
      if (isDurabilityFatal(error)) this.#tripDurability(session.id, error);
      throw error;
    }
  }

  #detachExecutor(sessionId: string, expectedExecutorId?: string): void {
    const identity = this.#executorIdentities.get(sessionId);
    if (expectedExecutorId !== undefined && identity?.executorId !== expectedExecutorId) return;
    this.#executorIdentities.delete(sessionId);
    const executor = this.#executors.get(sessionId);
    this.#executors.delete(sessionId);
    executor?.close();
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

export function sessionCreationRequestHash(
  request: Pick<CreateSessionRequest, "shell" | "workspaceRoot">,
): string {
  return hashRequest({ shell: request.shell, workspaceRoot: request.workspaceRoot });
}

export function executeRequestHash(request: Pick<ExecuteRequest, "command">): string {
  return hashRequest({ command: request.command });
}

export function executeApprovalActionRequestHash(
  request: Pick<
    ExecuteRequest,
    "actor" | "command" | "idempotencyKey" | "sessionGeneration" | "sessionId"
  >,
): string {
  return hashRequest({
    actor: request.actor,
    actionIdempotencyKey: request.idempotencyKey,
    executeRequestHash: executeRequestHash(request),
    operation: "execution.start",
    sessionGeneration: request.sessionGeneration,
    sessionId: request.sessionId,
  });
}

function validateGuardTtl(value: number | undefined): number {
  const ttlMilliseconds = value ?? DEFAULT_INTERACTION_GUARD_TTL_MS;
  if (
    !Number.isSafeInteger(ttlMilliseconds) ||
    ttlMilliseconds < MIN_INTERACTION_GUARD_TTL_MS ||
    ttlMilliseconds > MAX_INTERACTION_GUARD_TTL_MS
  ) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      `Interaction Guard TTL must be between ${MIN_INTERACTION_GUARD_TTL_MS.toString()} and ${MAX_INTERACTION_GUARD_TTL_MS.toString()} milliseconds`,
      { ttlMilliseconds },
    );
  }
  return ttlMilliseconds;
}

function validateGuardReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 1 || reason.length > 256 || reason.includes("\0")) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Interaction Guard reason must contain 1 to 256 non-NUL characters",
    );
  }
  return reason;
}

function sameActor(left: Actor, right: Actor): boolean {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.principal === right.principal &&
    left.client === right.client &&
    left.capabilities.length === right.capabilities.length &&
    left.capabilities.every((capability, index) => right.capabilities[index] === capability)
  );
}

function cloneInteractionState(state: InteractionState): InteractionState {
  return {
    ...state,
    ...(state.guard === undefined
      ? {}
      : {
          guard: {
            ...state.guard,
            actor: { ...state.guard.actor, capabilities: [...state.guard.actor.capabilities] },
          },
        }),
  };
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
  if (!validScreenRange(request.startRow, request.rowCount, MAX_TERMINAL_ROWS)) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      `Screen row region must fit within the ${MAX_TERMINAL_ROWS.toString()}-row maximum`,
    );
  }
  if (!validScreenRange(request.startColumn, request.columnCount, MAX_TERMINAL_COLUMNS)) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      `Screen column region must fit within the ${MAX_TERMINAL_COLUMNS.toString()}-column maximum`,
    );
  }
}

function validateTerminalGeometry(columns: number, rows: number): void {
  if (
    !Number.isSafeInteger(columns) ||
    columns < MIN_TERMINAL_COLUMNS ||
    columns > MAX_TERMINAL_COLUMNS ||
    !Number.isSafeInteger(rows) ||
    rows < MIN_TERMINAL_ROWS ||
    rows > MAX_TERMINAL_ROWS
  ) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      `Terminal geometry must be ${MIN_TERMINAL_COLUMNS.toString()}-${MAX_TERMINAL_COLUMNS.toString()} columns by ${MIN_TERMINAL_ROWS.toString()}-${MAX_TERMINAL_ROWS.toString()} rows`,
      { columns, rows },
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

function validateCheckpointEnvironmentKeys(keys: readonly string[]): readonly string[] {
  const unique = [...new Set(keys)];
  if (unique.length > MAX_CHECKPOINT_ENVIRONMENT_KEYS) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      `Checkpoint environment allowlist cannot exceed ${MAX_CHECKPOINT_ENVIRONMENT_KEYS.toString()} keys`,
    );
  }
  for (const key of unique) {
    if (
      !CHECKPOINT_ENVIRONMENT_NAME.test(key) ||
      SENSITIVE_CHECKPOINT_ENVIRONMENT_NAME.test(key) ||
      RUNTIME_UNSAFE_CHECKPOINT_ENVIRONMENT_NAME.test(key)
    ) {
      throw new RuntimeError(
        "INVALID_REQUEST",
        `Checkpoint environment key is invalid, credential-like, or Runtime-reserved: ${key}`,
        { environmentKey: key },
      );
    }
  }
  return unique.sort((left, right) => left.localeCompare(right));
}

function validateIdempotencyKey(value: string): void {
  if (value.length < 1 || value.length > 256 || value.includes("\0")) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Idempotency key must contain 1 to 256 non-NUL characters",
    );
  }
}

function validateExecuteCommand(command: string): void {
  if (command.includes("\0")) {
    throw new RuntimeError("INVALID_REQUEST", "Execute command cannot contain NUL bytes");
  }
}

function validateApprovalTtl(value: number | undefined): number {
  const ttlMilliseconds = value ?? DEFAULT_APPROVAL_TTL_MS;
  if (
    !Number.isSafeInteger(ttlMilliseconds) ||
    ttlMilliseconds < MIN_APPROVAL_TTL_MS ||
    ttlMilliseconds > MAX_APPROVAL_TTL_MS
  ) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      `Approval TTL must be between ${MIN_APPROVAL_TTL_MS.toString()} and ${MAX_APPROVAL_TTL_MS.toString()} milliseconds`,
      { ttlMilliseconds },
    );
  }
  return ttlMilliseconds;
}

function validateApprovalReason(value: string, label: string): string {
  const reason = value.trim();
  if (reason.length < 1 || reason.length > 512 || reason.includes("\0")) {
    throw new RuntimeError("INVALID_REQUEST", `${label} must contain 1 to 512 non-NUL characters`);
  }
  return reason;
}

function validateApprovalDecision(decision: ApprovalDecision): void {
  if (decision !== "approve" && decision !== "deny") {
    throw new RuntimeError("INVALID_REQUEST", "Approval decision must be approve or deny");
  }
}

function requireApprovalExpectedVersion(approval: Approval, expectedVersion: number): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new RuntimeError("INVALID_REQUEST", "Approval expectedVersion must be positive", {
      expectedVersion,
    });
  }
  if (approval.version !== expectedVersion) {
    throw new RuntimeError(
      "APPROVAL_CHANGED",
      "Approval version changed",
      {
        approvalId: approval.id,
        currentVersion: approval.version,
        expectedVersion,
        status: approval.status,
      },
      true,
    );
  }
}

function approvalRequired(approval: Approval): RuntimeError {
  return new RuntimeError(
    "APPROVAL_REQUIRED",
    "Agent Execute requires a matching approved request",
    {
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
      operation: approval.operation,
      status: approval.status,
      version: approval.version,
    },
    approval.status === "PENDING",
  );
}

function approvalChanged(approval: Approval): RuntimeError {
  return new RuntimeError(
    "APPROVAL_CHANGED",
    "Approval is no longer pending",
    {
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
      status: approval.status,
      version: approval.version,
    },
    false,
  );
}

function approvalRequestReplayScope(request: RequestExecuteApprovalRequest): string {
  return `${request.sessionId}\0${request.actor.id}\0${request.requestIdempotencyKey}`;
}

function cloneActor(actor: Actor): Actor {
  return { ...actor, capabilities: [...actor.capabilities] };
}

function cloneSensitiveInput(sensitiveInput: SensitiveInput): SensitiveInput {
  return { ...sensitiveInput, actor: cloneActor(sensitiveInput.actor) };
}

function cloneApproval(approval: Approval): Approval {
  return {
    ...approval,
    requester: cloneActor(approval.requester),
    ...(approval.approver === undefined ? {} : { approver: cloneActor(approval.approver) }),
  };
}

async function canonicalWorkspace(workspaceRoot: string): Promise<string> {
  try {
    const canonical = await realpath(workspaceRoot);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Workspace root must resolve to an existing directory",
      { pathKind: "workspace_root" },
    );
  }
}

async function canonicalCheckpointCwd(workspaceRoot: string, cwd: string): Promise<string> {
  try {
    const canonical = await realpath(cwd);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    const childPath = relative(workspaceRoot, canonical);
    if (
      childPath !== "" &&
      (childPath === ".." || childPath.startsWith("../") || isAbsolute(childPath))
    ) {
      throw new Error("outside workspace root");
    }
    return canonical;
  } catch {
    throw new RuntimeError(
      "CHECKPOINT_INVALID",
      "Checkpoint cwd must resolve to a directory inside its workspace",
      { pathKind: "checkpoint_cwd" },
    );
  }
}

async function validateCheckpointPath(checkpoint: ShellCheckpoint): Promise<void> {
  const workspaceRoot = await canonicalWorkspace(checkpoint.workspaceRoot).catch(
    (error: unknown) => {
      throw new RuntimeError(
        "CHECKPOINT_INVALID",
        "Checkpoint workspace no longer resolves to a directory",
        { reason: errorMessage(error), sessionId: checkpoint.sessionId },
      );
    },
  );
  const cwd = await canonicalCheckpointCwd(workspaceRoot, checkpoint.cwd);
  if (workspaceRoot !== checkpoint.workspaceRoot || cwd !== checkpoint.cwd) {
    throw new RuntimeError(
      "CHECKPOINT_INVALID",
      "Checkpoint canonical paths changed after observation",
      { sessionId: checkpoint.sessionId },
    );
  }
}

function checkpointView(
  checkpoint: ShellCheckpoint,
  sourceStatus: Session["status"],
  now: Date,
): ShellCheckpointView {
  return {
    ageMilliseconds: Math.max(0, now.getTime() - new Date(checkpoint.observedAt).getTime()),
    contentHash: checkpoint.contentHash,
    cwd: checkpoint.cwd,
    environmentKeys: Object.keys(checkpoint.filteredEnvironment).sort((left, right) =>
      left.localeCompare(right),
    ),
    observedAt: checkpoint.observedAt,
    sessionId: checkpoint.sessionId,
    shell: checkpoint.shell,
    sourceGeneration: checkpoint.sourceGeneration,
    sourceStatus,
    stale: sourceStatus !== "READY",
    version: checkpoint.version,
    workspaceRoot: checkpoint.workspaceRoot,
  };
}

function forkReplayScope(request: ForkSessionRequest): string {
  return `${request.sessionId}\0${request.actor.id}\0${request.idempotencyKey}`;
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

function utf8Prefix(
  value: string,
  start: number,
  maximumBytes: number,
): Readonly<{ byteLength: number; codeUnits: number }> {
  let bytes = 0;
  let codeUnits = 0;
  while (start + codeUnits < value.length) {
    const codePoint = value.codePointAt(start + codeUnits);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    const codePointText = value.slice(start + codeUnits, start + codeUnits + width);
    const codePointBytes = byteLength(codePointText);
    if (bytes + codePointBytes > maximumBytes) break;
    bytes += codePointBytes;
    codeUnits += width;
  }
  return { byteLength: bytes, codeUnits };
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
  if (
    error instanceof RuntimeError &&
    (error.code === "RUNTIME_UNAVAILABLE" ||
      error.code === "OWNER_LEASE_LOST" ||
      error.code === "SESSION_LEASE_LOST")
  ) {
    return error;
  }
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
    if (error.code === "OWNER_LEASE_LOST" || error.code === "SESSION_LEASE_LOST") return true;
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
    error.code === "DELIVERY_UNKNOWN" ||
    error.code === "OWNER_LEASE_LOST" ||
    error.code === "SESSION_LEASE_LOST"
  );
}

function missingSessionLease(
  session: Pick<Session, "generation" | "id" | "ownerId">,
): RuntimeError {
  return new RuntimeError(
    "SESSION_LEASE_LOST",
    "Runtime has no current fence for this Session generation",
    { generation: session.generation, ownerId: session.ownerId, sessionId: session.id },
    false,
  );
}

function executionVersion(execution: Execution): Readonly<{ id: string; version: number }> {
  return { id: execution.id, version: execution.version };
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeError("INVALID_REQUEST", `${name} must be a positive integer`, {
      [name]: value,
    });
  }
  return value;
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
