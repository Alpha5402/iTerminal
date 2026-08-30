import type {
  Actor,
  ControlAction,
  ControlDelivery,
  EventPage,
  ExecuteAction,
  Execution,
  InputAction,
  InteractionState,
  ResizeAction,
  Session,
  SessionAction,
  SessionEvent,
  ShellCheckpoint,
  ShellKind,
  TerminalScreenCellsResult,
  TerminalScreenSnapshot,
  TerminalScreenDiffResult,
  TerminalScreenRegionResult,
  TerminalScreenSearchResult,
} from "@iterminal/domain";

export interface ShellExecutionResult {
  readonly exitCode: number;
  readonly cwd: string;
  readonly filteredEnvironment: Readonly<Record<string, string>>;
  readonly output: string;
  readonly outputTruncated: boolean;
}

export interface ShellExecuteCallbacks {
  readonly onStarted: (observedCommand: string) => void;
}

export interface ShellExecutor {
  readonly shellPid: number;
  readonly shell: ShellKind;
  checkpoint(): Readonly<{
    cwd: string;
    filteredEnvironment: Readonly<Record<string, string>>;
  }>;
  execute(command: string, callbacks: ShellExecuteCallbacks): Promise<ShellExecutionResult>;
  writeInput(data: string): void;
  sendControl(delivery: ControlDelivery): void;
  resize(columns: number, rows: number): void;
  close(): void;
}

export interface CreateExecutorOptions {
  readonly checkpointEnvironmentKeys: readonly string[];
  readonly initialCwd?: string;
  readonly initialEnvironment?: Readonly<Record<string, string>>;
  readonly shell: ShellKind;
  readonly workspaceRoot: string;
  readonly onOutput: (data: string) => void;
}

export interface ShellExecutorFactory {
  create(options: CreateExecutorOptions): Promise<ShellExecutor>;
}

export interface TerminalScreenProjection {
  cells(input: {
    readonly columnCount: number;
    readonly rowCount: number;
    readonly startColumn: number;
    readonly startRow: number;
  }): Promise<TerminalScreenCellsResult>;
  diff(afterVersion: number): Promise<TerminalScreenDiffResult>;
  dispose(): void;
  region(input: {
    readonly columnCount: number;
    readonly rowCount: number;
    readonly startColumn: number;
    readonly startRow: number;
  }): Promise<TerminalScreenRegionResult>;
  resize(columns: number, rows: number, screenVersion: number): Promise<TerminalScreenSnapshot>;
  search(input: {
    readonly caseSensitive: boolean;
    readonly maxMatches: number;
    readonly query: string;
  }): Promise<TerminalScreenSearchResult>;
  snapshot(): Promise<TerminalScreenSnapshot>;
  waitForVersion(
    afterVersion: number,
    timeoutMilliseconds: number,
    signal?: AbortSignal,
  ): Promise<TerminalScreenSnapshot | undefined>;
  write(data: string, screenVersion: number): void;
}

export interface TerminalScreenProjectionFactory {
  create(input: {
    readonly sessionGeneration: number;
    readonly sessionId: string;
  }): TerminalScreenProjection;
}

export interface RuntimeStore {
  createSession(session: Session): void;
  deleteSession(sessionId: string, generation: number): void;
  getSession(sessionId: string): Session | undefined;
  listSessions(): readonly Session[];
  markSessionReady(sessionId: string, generation: number): Session;
  reserveSession(sessionId: string, generation: number, executionId: string): Session;
  cancelReservation(sessionId: string, generation: number, executionId: string): Session;
  markSessionRunning(sessionId: string, generation: number, executionId: string): Session;
  releaseSession(sessionId: string, generation: number, executionId: string): Session;
  breakSession(sessionId: string, generation: number): Session;
  closeSession(sessionId: string, generation: number): Session;
  bumpScreenVersion(sessionId: string, generation: number): number;
  nextActionSequence(sessionId: string, generation: number): number;
  rollbackActionSequence(sessionId: string, generation: number, actionSequence: number): void;
  saveAction(action: SessionAction): void;
  getActionByIdempotency(scope: string, idempotencyKey: string): SessionAction | undefined;
  bindIdempotency(scope: string, idempotencyKey: string, actionId: string): void;
  getAction(actionId: string): SessionAction | undefined;
  saveExecution(execution: Execution): void;
  getExecution(executionId: string): Execution | undefined;
  appendEvent(
    sessionId: string,
    generation: number,
    event: Omit<SessionEvent, "sequence">,
  ): SessionEvent;
  queryEvents(
    sessionId: string,
    generation: number,
    after: number,
    limit: number,
  ): readonly SessionEvent[];
}

export type DurableSessionEvent = Omit<SessionEvent, "sequence">;

export interface DurableExecuteAdmission {
  readonly action: ExecuteAction;
  readonly execution: Execution;
  readonly acceptedEvent: DurableSessionEvent;
  readonly dispatchingEvent: DurableSessionEvent;
}

export interface DurableExecuteAdmissionResult {
  readonly actionId: string;
  readonly executionId: string;
  readonly actionSequence: number;
  readonly replayed: boolean;
}

export interface DurableForkAdmission {
  readonly actor: Actor;
  readonly checkpoint: ShellCheckpoint;
  readonly child: Session;
  readonly childEvents: readonly DurableSessionEvent[];
  readonly expectedCheckpointHash: string;
  readonly expectedCheckpointVersion: number;
  readonly expectedParentStatus: Session["status"];
  readonly idempotencyKey: string;
  readonly parent: Session;
  readonly parentEvent: DurableSessionEvent;
  readonly requestHash: string;
}

export interface DurableRebuildableSession {
  readonly checkpoint: ShellCheckpoint;
  readonly session: Session;
}

export interface DurableOwnerRecoveryResult {
  readonly brokenSessions: number;
  readonly rebuildableSessions: readonly DurableRebuildableSession[];
  readonly unknownExecutions: number;
}

export type RuntimeOwnerStatus = "ACTIVE" | "DRAINING" | "STOPPED";

export interface RuntimeOwnerIdentity {
  readonly epoch: number;
  readonly instanceId: string;
  readonly ownerId: string;
}

export interface RuntimeOwnerRoute extends RuntimeOwnerIdentity {
  readonly endpoint: string;
  readonly heartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly startedAt: string;
  readonly status: RuntimeOwnerStatus;
  readonly stoppedAt?: string;
  readonly version: number;
}

export interface RuntimeOwnerRecord extends RuntimeOwnerRoute {
  readonly activeSessionCount: number;
  readonly capacityWeight: number;
  readonly placementCount: number;
}

export interface SessionFence extends RuntimeOwnerIdentity {
  readonly fencingToken: string;
  readonly generation: number;
  readonly sessionId: string;
}

export interface SessionLease extends SessionFence {
  readonly acquiredAt: string;
  readonly leaseExpiresAt: string;
  readonly renewedAt: string;
  readonly version: number;
}

export interface RuntimeRouteResolution {
  readonly liveOwner?: RuntimeOwnerRoute;
  readonly ownerId: string;
}

export interface SessionCreationClaim {
  readonly owner: RuntimeOwnerRoute;
  readonly sessionId?: string;
}

export interface DurableSessionCreation {
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export type DurableSessionCreationResult =
  | { readonly kind: "created"; readonly lease: SessionLease }
  | { readonly kind: "replay"; readonly sessionId: string };

export interface RuntimeOwnerRegistry {
  registerOwner(input: {
    readonly capacityWeight?: number;
    readonly endpoint: string;
    readonly instanceId: string;
    readonly leaseMilliseconds: number;
    readonly ownerId: string;
  }): Promise<RuntimeOwnerRecord>;
  heartbeatOwner(
    identity: RuntimeOwnerIdentity,
    leaseMilliseconds: number,
  ): Promise<RuntimeOwnerRecord>;
  beginOwnerDrain(
    identity: RuntimeOwnerIdentity,
    leaseMilliseconds: number,
  ): Promise<RuntimeOwnerRecord>;
  stopOwner(identity: RuntimeOwnerIdentity): Promise<RuntimeOwnerRecord>;
  claimAssignableOwner(): Promise<RuntimeOwnerRecord | undefined>;
  claimSessionCreation(input: DurableSessionCreation): Promise<SessionCreationClaim | undefined>;
  listAssignableOwners(): Promise<readonly RuntimeOwnerRecord[]>;
  listSessionOwnerRoutes(): Promise<readonly RuntimeRouteResolution[]>;
  resolveLiveOwner(ownerId: string): Promise<RuntimeOwnerRecord | undefined>;
  resolveSessionRoute(sessionId: string): Promise<RuntimeRouteResolution | undefined>;
  resolveExecutionRoute(executionId: string): Promise<RuntimeRouteResolution | undefined>;
}

export interface RuntimeDurability {
  createSession(
    session: Session,
    events: readonly DurableSessionEvent[],
    owner: RuntimeOwnerIdentity,
    leaseMilliseconds: number,
    creation: DurableSessionCreation,
  ): Promise<DurableSessionCreationResult>;
  renewSessionLeases(
    owner: RuntimeOwnerIdentity,
    leases: readonly SessionFence[],
    leaseMilliseconds: number,
  ): Promise<readonly SessionLease[]>;
  markSessionReady(
    fence: SessionFence,
    session: Session,
    shellPid: number,
    event: DurableSessionEvent,
    checkpoint: ShellCheckpoint,
    additionalEvents?: readonly DurableSessionEvent[],
  ): Promise<void>;
  createForkSession(
    input: DurableForkAdmission,
    owner: RuntimeOwnerIdentity,
    leaseMilliseconds: number,
    parentFence?: SessionFence,
  ): Promise<SessionLease>;
  markSessionBroken(
    fence: SessionFence,
    session: Session,
    events: readonly DurableSessionEvent[],
    reason: string,
    activeExecution?: Readonly<{ readonly id: string; readonly version: number }>,
  ): Promise<void>;
  closeSession(
    fence: SessionFence,
    session: Session,
    event: DurableSessionEvent,
    activeExecution?: Readonly<{ readonly id: string; readonly version: number }>,
  ): Promise<void>;
  acceptExecute(
    fence: SessionFence,
    input: DurableExecuteAdmission,
  ): Promise<DurableExecuteAdmissionResult>;
  markExecutionRunning(input: {
    readonly fence: SessionFence;
    readonly expectedExecutionVersion: number;
    readonly session: Session;
    readonly action: ExecuteAction;
    readonly execution: Execution;
    readonly event: DurableSessionEvent;
  }): Promise<void>;
  markExecutionWriteAttempted(input: {
    readonly fence: SessionFence;
    readonly expectedExecutionVersion: number;
    readonly session: Session;
    readonly action: ExecuteAction;
    readonly execution: Execution;
    readonly event: DurableSessionEvent;
  }): Promise<void>;
  finishExecution(input: {
    readonly fence: SessionFence;
    readonly expectedExecutionVersion: number;
    readonly session: Session;
    readonly action: ExecuteAction;
    readonly execution: Execution;
    readonly events: readonly DurableSessionEvent[];
    readonly checkpoint?: ShellCheckpoint;
  }): Promise<void>;
  failExecution(input: {
    readonly fence: SessionFence;
    readonly expectedExecutionVersion: number;
    readonly session: Session;
    readonly action: ExecuteAction;
    readonly execution: Execution;
    readonly events: readonly DurableSessionEvent[];
    readonly reason: string;
  }): Promise<void>;
  acceptInteraction(
    fence: SessionFence,
    action: InputAction | ControlAction,
    event: DurableSessionEvent,
  ): Promise<void>;
  markInteractionWriteAttempted(
    fence: SessionFence,
    action: InputAction | ControlAction,
    event: DurableSessionEvent,
  ): Promise<void>;
  finishInteraction(
    fence: SessionFence,
    action: InputAction | ControlAction,
    event: DurableSessionEvent,
  ): Promise<void>;
  acceptResize(
    fence: SessionFence,
    action: ResizeAction,
    event: DurableSessionEvent,
  ): Promise<void>;
  markResizeWriteAttempted(
    fence: SessionFence,
    action: ResizeAction,
    event: DurableSessionEvent,
  ): Promise<void>;
  finishResize(input: {
    readonly fence: SessionFence;
    readonly action: ResizeAction;
    readonly event: DurableSessionEvent;
    readonly session: Session;
    readonly brokenEvent?: DurableSessionEvent;
    readonly activeExecution?: Readonly<{ readonly id: string; readonly version: number }>;
  }): Promise<void>;
  saveInteractionState(
    fence: SessionFence,
    state: InteractionState,
    expectedVersion: number,
    event: DurableSessionEvent,
  ): Promise<void>;
  appendEvent(fence: SessionFence, event: DurableSessionEvent): Promise<void>;
  appendOwnerEvent(owner: RuntimeOwnerIdentity, event: DurableSessionEvent): Promise<void>;
  queryEvents(
    sessionId: string,
    generation: number,
    after: number,
    limit: number,
  ): Promise<EventPage>;
  recoverOwner(owner: RuntimeOwnerIdentity, reason: string): Promise<DurableOwnerRecoveryResult>;
}

export interface RuntimeServiceOptions {
  readonly checkpointEnvironmentKeys?: readonly string[];
  readonly durability?: RuntimeDurability;
  readonly executionDispatch?: "external" | "immediate";
  readonly hooks?: Readonly<{
    readonly afterControlWrite?: (action: ControlAction) => void;
    readonly afterExecutionWrite?: (execution: Execution) => void;
    readonly afterInputWrite?: (action: InputAction) => void;
    readonly afterResizeWrite?: (action: ResizeAction) => void;
    readonly beforeExecutionFinishPersist?: (execution: Execution) => void;
  }>;
  readonly ownerId?: string;
  readonly sessionLeaseMilliseconds?: number;
  readonly screenProjectionFactory?: TerminalScreenProjectionFactory;
  readonly now?: () => Date;
}
