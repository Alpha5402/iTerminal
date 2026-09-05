import type {
  Actor,
  AgentExecuteApprovalPolicy,
  Approval,
  ControlAction,
  ControlDelivery,
  EventPage,
  ExecuteAction,
  Execution,
  InputAction,
  InteractionState,
  ResizeAction,
  SecretInputAction,
  SensitiveInput,
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
  TerminalCursorResponse,
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
  readonly onWriteAccepted?: () => void;
}

export interface ShellExecutorLifecycleEvent {
  readonly executorId: string;
  readonly reason: "executor_failure" | "shell_process_exit";
  readonly sessionGeneration: number;
  readonly sessionId: string;
  readonly type: "exited";
  readonly exitCode?: number;
  readonly signal?: number;
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
  writeSecret(data: string): void;
  finishSensitiveOutput(): void;
  sendControl(delivery: ControlDelivery): void;
  resize(columns: number, rows: number): void;
  close(): void;
}

export interface CreateExecutorOptions {
  readonly checkpointEnvironmentKeys: readonly string[];
  readonly executorId: string;
  readonly initialCwd?: string;
  readonly initialEnvironment?: Readonly<Record<string, string>>;
  readonly onLifecycle: (event: ShellExecutorLifecycleEvent) => void;
  readonly shell: ShellKind;
  readonly sessionGeneration: number;
  readonly sessionId: string;
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
  write(
    data: string,
    screenVersion: number,
    onResponse?: (response: TerminalCursorResponse) => void,
  ): void;
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

export const DEFAULT_ARTIFACT_READ_BYTES = 8 * 1024;
export const MAX_ARTIFACT_READ_BYTES = 64 * 1024;
export const DEFAULT_EXECUTION_OUTPUT_READ_BYTES = 8 * 1024;
export const MAX_EXECUTION_OUTPUT_READ_BYTES = 64 * 1024;
export const MAX_EXECUTION_OUTPUT_RESPONSE_BYTES = 96 * 1024;
export const DEFAULT_EXECUTION_WAIT_MILLISECONDS = 10_000;
export const MAX_EXECUTION_WAIT_MILLISECONDS = 30_000;
export const MAX_EXECUTION_OBSERVATION_TEXT_SOURCE_BYTES = 8 * 1024;
export const MAX_EXECUTION_OBSERVATION_TEXT_BYTES = 32 * 1024;
export const MAX_EXECUTION_OBSERVATION_RESPONSE_BYTES = 96 * 1024;

export interface ArtifactReadRequest {
  readonly artifactId: string;
  readonly generation: number;
  readonly maxBytes?: number;
  readonly offsetBytes: number;
  readonly sessionId: string;
}

interface ArtifactReadIdentity {
  readonly artifactId: string;
  readonly generation: number;
  readonly sessionId: string;
}

export interface ArtifactReadFound extends ArtifactReadIdentity {
  readonly contentBase64: string;
  readonly contentType: string;
  readonly eof: boolean;
  readonly kind: "found";
  readonly nextOffset: number;
  readonly offsetBytes: number;
  readonly returnedBytes: number;
  readonly totalBytes: number;
}

export type DurableArtifactReadResult =
  | ArtifactReadFound
  | (ArtifactReadIdentity & Readonly<{ kind: "not_found"; message: string }>)
  | (ArtifactReadIdentity & Readonly<{ expiredAt: string; kind: "expired"; message: string }>);

export type ArtifactReadResult =
  | DurableArtifactReadResult
  | (ArtifactReadIdentity &
      Readonly<{
        kind: "unavailable";
        message: string;
        reason: "durability_unavailable" | "owner_route_unavailable";
        retryable: true;
      }>);

export interface ExecutionOutputReadRequest {
  readonly cursor?: string;
  readonly executionId: string;
  readonly generation: number;
  readonly maxBytes?: number;
  readonly sessionId: string;
}

export interface ExecutionOutputChunk {
  readonly byteLength: number;
  readonly contentBase64: string;
}

export type ExecutionOutputGap =
  | Readonly<{
      kind: "event_retention";
      minimumAvailableSequence: number;
    }>
  | Readonly<{
      eventSequence: number;
      kind: "artifact_expired" | "artifact_missing";
      resumeCursor: string;
    }>;

export interface ExecutionOutputReadResult {
  readonly chunks: readonly ExecutionOutputChunk[];
  readonly encoding: "base64";
  readonly executionId: string;
  readonly executionState: Execution["status"];
  readonly gap: ExecutionOutputGap | null;
  readonly generation: number;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly persistenceLag: "none" | "possible";
  readonly retention: Readonly<{
    minimumAvailableSequence: number;
    source: "durable";
  }>;
  readonly sessionId: string;
  readonly stream: "pty";
}

export interface ExecutionWaitRequest {
  readonly executionId: string;
  readonly waitMs?: number;
}

export interface ExecutionWaitResult {
  readonly completed: boolean;
  readonly executionId: string;
  readonly executionState: Execution["status"];
}

export interface ExecutionObservationRequest extends ExecutionOutputReadRequest {
  readonly waitMs?: number;
}

export type ExecutionObservationNextAction =
  "continue_output" | "wait_for_completion" | "acknowledge_output_gap" | "lookup_original_action";

export interface ExecutionObservationResult {
  readonly gap: ExecutionOutputGap | null;
  readonly identity: Readonly<{
    readonly executionId: string;
    readonly generation: number;
    readonly sessionId: string;
  }>;
  readonly nextActions: readonly ExecutionObservationNextAction[];
  readonly nextCursor: string | null;
  readonly output: Readonly<{
    readonly byteLength: number;
    readonly contentBase64: string;
    readonly encoding: "base64";
    readonly hasMore: boolean;
    readonly retention: Readonly<{
      readonly minimumAvailableSequence: number;
      readonly source: "durable";
    }>;
    readonly stream: "pty";
    readonly text?: string | undefined;
    readonly textStatus: "complete" | "unaligned_utf8" | "omitted_for_budget";
  }>;
  readonly state: Readonly<{
    readonly completed: boolean;
    readonly executionState: Execution["status"];
    readonly persistenceLag: "none" | "possible";
  }>;
}

export interface ExecutionWaitScheduler {
  clearTimeout(handle: unknown): void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
}

export interface ActionLookupRequest {
  readonly actor: Actor;
  readonly generation: number;
  readonly idempotencyKey: string;
  readonly sessionId: string;
}

export interface ActionLookupFound extends Omit<ActionLookupRequest, "actor"> {
  readonly acceptedAt: string;
  readonly actionId: string;
  readonly actionStatus: SessionAction["status"];
  readonly actionType: SessionAction["type"];
  readonly executionId?: string | undefined;
  readonly executionStatus?: Execution["status"] | undefined;
  readonly kind: "found";
}

export type ActionLookupResult =
  | ActionLookupFound
  | (Omit<ActionLookupRequest, "actor"> &
      Readonly<{
        kind: "not_found";
        mayStillBeInFlight: true;
        message: string;
      }>)
  | (Omit<ActionLookupRequest, "actor"> &
      Readonly<{
        expiredAt: string;
        kind: "expired";
        message: string;
      }>)
  | (Omit<ActionLookupRequest, "actor"> &
      Readonly<{
        kind: "unavailable";
        message: string;
        reason: "durability_unavailable" | "owner_route_unavailable";
        retryable: true;
      }>);

export interface DurableExecuteAdmission {
  readonly action: ExecuteAction;
  readonly execution: Execution;
  readonly acceptedEvent: DurableSessionEvent;
  readonly dispatchingEvent: DurableSessionEvent;
  readonly approvalConsumption?: Readonly<{
    readonly actionRequestHash: string;
    readonly approvalId: string;
    readonly consumedAt: string;
    readonly event: DurableSessionEvent;
  }>;
}

export interface DurableApprovalRequest {
  readonly approval: Approval;
  readonly event: DurableSessionEvent;
}

export interface DurableApprovalDecision {
  readonly approvalId: string;
  readonly approver: Actor;
  readonly decidedAt: string;
  readonly decision: "approve" | "deny";
  readonly decisionIdempotencyKey: string;
  readonly decisionReason: string;
  readonly decisionRequestHash: string;
  readonly event: DurableSessionEvent;
  readonly expectedVersion: number;
  readonly sessionGeneration: number;
  readonly sessionId: string;
}

export interface DurableApprovalMutationResult {
  readonly approval: Approval;
  readonly replayed: boolean;
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
  lookupAction(request: ActionLookupRequest): Promise<ActionLookupFound | undefined>;
  readArtifact?(request: ArtifactReadRequest): Promise<DurableArtifactReadResult>;
  readExecutionOutput?(request: ExecutionOutputReadRequest): Promise<ExecutionOutputReadResult>;
  requestApproval(
    fence: SessionFence,
    input: DurableApprovalRequest,
  ): Promise<DurableApprovalMutationResult>;
  getApproval(sessionId: string, generation: number, approvalId: string): Promise<Approval>;
  listApprovals(sessionId: string, generation: number): Promise<readonly Approval[]>;
  decideApproval(
    fence: SessionFence,
    input: DurableApprovalDecision,
  ): Promise<DurableApprovalMutationResult>;
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
  acceptSecretInput(
    fence: SessionFence,
    action: SecretInputAction,
    sensitiveInput: SensitiveInput,
    event: DurableSessionEvent,
  ): Promise<void>;
  markInteractionWriteAttempted(
    fence: SessionFence,
    action: InputAction | SecretInputAction | ControlAction,
    event: DurableSessionEvent,
  ): Promise<void>;
  finishInteraction(
    fence: SessionFence,
    action: InputAction | SecretInputAction | ControlAction,
    event: DurableSessionEvent,
  ): Promise<void>;
  finishSensitiveInput(
    fence: SessionFence,
    sensitiveInput: SensitiveInput,
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
  readonly agentExecuteApproval?: AgentExecuteApprovalPolicy;
  readonly checkpointEnvironmentKeys?: readonly string[];
  readonly durability?: RuntimeDurability;
  readonly executionDispatch?: "external" | "immediate";
  readonly executionWaitScheduler?: ExecutionWaitScheduler;
  readonly hooks?: Readonly<{
    readonly afterControlWrite?: (action: ControlAction) => void;
    readonly afterExecutionWrite?: (execution: Execution) => void;
    readonly afterInputWrite?: (action: InputAction) => void;
    readonly afterSecretInputWrite?: (action: SecretInputAction) => void;
    readonly afterResizeWrite?: (action: ResizeAction) => void;
    readonly beforeExecutionFinishPersist?: (execution: Execution) => void;
  }>;
  readonly ownerId?: string;
  readonly sessionLeaseMilliseconds?: number;
  readonly screenProjectionFactory?: TerminalScreenProjectionFactory;
  readonly now?: () => Date;
}
