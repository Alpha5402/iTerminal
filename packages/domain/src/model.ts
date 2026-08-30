export type ActorType = "human" | "agent" | "scheduler" | "system";
export const ACTOR_CAPABILITIES = Object.freeze([
  "approval.decide",
  "approval.request",
  "interaction.guard.manage",
  "interaction.policy.manage",
  "secret.input",
  "session.execute",
  "session.fork",
  "terminal.control",
  "terminal.input",
  "terminal.resize",
] as const);
export type ActorCapability = (typeof ACTOR_CAPABILITIES)[number];

export const ACTOR_CAPABILITY_PROFILES: Readonly<Record<ActorType, readonly ActorCapability[]>> =
  Object.freeze({
    agent: Object.freeze([
      "approval.request",
      "session.execute",
      "session.fork",
      "terminal.control",
      "terminal.input",
      "terminal.resize",
    ] as const),
    human: Object.freeze([
      "approval.decide",
      "approval.request",
      "interaction.guard.manage",
      "interaction.policy.manage",
      "secret.input",
      "session.execute",
      "session.fork",
      "terminal.control",
      "terminal.input",
      "terminal.resize",
    ] as const),
    scheduler: Object.freeze(["session.execute"] as const),
    system: Object.freeze([
      "interaction.policy.manage",
      "session.execute",
      "session.fork",
      "terminal.control",
      "terminal.resize",
    ] as const),
  });
export type ShellKind = "bash" | "zsh";
export type SessionStatus = "STARTING" | "READY" | "RESERVED" | "RUNNING" | "BROKEN" | "CLOSED";
export type ExecuteActionStatus =
  | "ACCEPTED"
  | "DISPATCHING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "INTERRUPTED"
  | "UNKNOWN"
  | "CANCELLED";
export type InteractionActionStatus = "ACCEPTED" | "DELIVERED" | "REJECTED" | "UNKNOWN";
export type InputPolicyMode = "common" | "human_guarded" | "human_only" | "agent_only";
export type AgentExecuteApprovalPolicy = "optional" | "required";
export type ApprovalDecision = "approve" | "deny";
export type ApprovalStatus = "PENDING" | "APPROVED" | "DENIED" | "EXPIRED" | "CONSUMED";
export const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1_000;
export const MIN_APPROVAL_TTL_MS = 30 * 1_000;
export const MAX_APPROVAL_TTL_MS = 30 * 60 * 1_000;
export type ExecutionStatus =
  "DISPATCHING" | "RUNNING" | "COMPLETED" | "FAILED" | "INTERRUPTED" | "UNKNOWN";
export type TtyControl = "CTRL_C" | "CTRL_D" | "CTRL_Z" | "ESC";
export type ProcessSignal = "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGTSTP" | "SIGCONT";
export type ControlDelivery =
  | Readonly<{ mode: "TTY_CONTROL"; control: TtyControl }>
  | Readonly<{ mode: "PROCESS_SIGNAL"; signal: ProcessSignal }>;

export const CANONICAL_TERMINAL_COLUMNS = 120;
export const CANONICAL_TERMINAL_ROWS = 40;
export const MIN_TERMINAL_COLUMNS = 40;
export const MAX_TERMINAL_COLUMNS = 240;
export const MIN_TERMINAL_ROWS = 12;
export const MAX_TERMINAL_ROWS = 100;
export const TERMINAL_SCREEN_HISTORY_ENTRIES = 64;
export const DEFAULT_INTERACTION_GUARD_TTL_MS = 500;
export const MIN_INTERACTION_GUARD_TTL_MS = 50;
export const MAX_INTERACTION_GUARD_TTL_MS = 5_000;
export const MAX_INTERACTION_GUARD_RENEWALS = 3;

export interface TerminalScreenFrame {
  readonly buffer: "normal" | "alternate";
  readonly columns: number;
  readonly cursor: Readonly<{ column: number; row: number }>;
  readonly geometryVersion: number;
  readonly rows: number;
  readonly screenVersion: number;
  readonly sessionGeneration: number;
  readonly sessionId: string;
}

export interface TerminalScreenSnapshot extends TerminalScreenFrame {
  readonly lines: readonly string[];
}

export interface TerminalScreenRegionResult {
  readonly columnCount: number;
  readonly frame: TerminalScreenFrame;
  readonly lines: readonly string[];
  readonly rowCount: number;
  readonly startColumn: number;
  readonly startRow: number;
}

export type TerminalScreenColor =
  | Readonly<{ mode: "palette"; index: number }>
  | Readonly<{ mode: "rgb"; blue: number; green: number; red: number }>;

export interface TerminalScreenCellStyle {
  readonly background?: TerminalScreenColor;
  readonly blink?: true;
  readonly bold?: true;
  readonly dim?: true;
  readonly foreground?: TerminalScreenColor;
  readonly invisible?: true;
  readonly inverse?: true;
  readonly italic?: true;
  readonly overline?: true;
  readonly strikethrough?: true;
  readonly underline?: true;
}

export interface TerminalScreenCell {
  readonly column: number;
  readonly row: number;
  readonly style: TerminalScreenCellStyle;
  readonly text: string;
  readonly width: number;
}

export interface TerminalScreenCellsResult {
  readonly cells: readonly TerminalScreenCell[];
  readonly columnCount: number;
  readonly frame: TerminalScreenFrame;
  readonly rowCount: number;
  readonly startColumn: number;
  readonly startRow: number;
}

export interface TerminalScreenChangedRow {
  readonly row: number;
  readonly text: string;
}

export type TerminalScreenDiffResult =
  | Readonly<{
      afterVersion: number;
      changedRows: readonly TerminalScreenChangedRow[];
      frame: TerminalScreenFrame;
      resyncRequired: false;
    }>
  | Readonly<{
      afterVersion: number;
      reason: "future_version" | "geometry_changed" | "history_unavailable";
      resyncRequired: true;
      snapshot: TerminalScreenSnapshot;
    }>;

export interface TerminalScreenMatch {
  readonly endColumn: number;
  readonly row: number;
  readonly startColumn: number;
  readonly text: string;
}

export interface TerminalScreenSearchResult {
  readonly matches: readonly TerminalScreenMatch[];
  readonly snapshot: TerminalScreenSnapshot;
  readonly truncated: boolean;
}

export interface TerminalScreenWaitResult {
  readonly matched: boolean;
  readonly reason: "condition" | "timeout";
  readonly snapshot: TerminalScreenSnapshot;
  readonly waitedMilliseconds: number;
  readonly execution?: Execution;
}

export type TerminalStateKind =
  "shell_ready" | "running" | "editor" | "pager" | "repl" | "password" | "confirm" | "unknown";

export type TerminalStateConfidence = "high" | "medium" | "low";

export type TerminalStateEvidenceCode =
  | "session.starting"
  | "session.ready"
  | "session.reserved"
  | "session.running"
  | "session.broken"
  | "session.closed"
  | "execution.running"
  | "command.editor_family"
  | "command.pager_family"
  | "command.repl_family"
  | "command.monitor_family"
  | "screen.alternate_buffer"
  | "screen.editor_marker"
  | "screen.pager_marker"
  | "screen.repl_prompt"
  | "screen.password_prompt"
  | "screen.confirm_prompt";

export interface TerminalStateEvidence {
  readonly code: TerminalStateEvidenceCode;
  readonly source: "runtime" | "execution" | "screen";
  readonly strength: "fact" | "signal";
}

export type TerminalStateLimitation =
  | "advisory_not_authorization"
  | "not_readiness_or_completion"
  | "screen_content_spoofable"
  | "command_may_not_be_foreground"
  | "terminal_echo_mode_unobserved"
  | "process_state_not_reconstructed";

export interface TerminalStateObservation {
  readonly advisory: true;
  readonly confidence: TerminalStateConfidence;
  readonly evidence: readonly TerminalStateEvidence[];
  readonly executionId?: string;
  readonly frame: TerminalScreenFrame;
  readonly kind: TerminalStateKind;
  readonly limitations: readonly TerminalStateLimitation[];
  readonly observedAt: string;
  readonly sessionStatus: SessionStatus;
}

export interface Actor {
  readonly capabilities: readonly ActorCapability[];
  readonly id: string;
  readonly type: ActorType;
  readonly principal: string;
  readonly client: string;
}

export function actorHasCapability(actor: Actor, capability: ActorCapability): boolean {
  return actor.capabilities.includes(capability);
}

export function isCanonicalActorCapabilities(capabilities: readonly ActorCapability[]): boolean {
  return (
    capabilities.length > 0 &&
    capabilities.every(
      (capability, index) =>
        ACTOR_CAPABILITIES.includes(capability) &&
        (index === 0 || capabilities[index - 1]! < capability),
    )
  );
}

export interface InteractionGuard {
  readonly id: string;
  readonly actor: Actor;
  readonly reason: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly renewals: number;
  readonly maxRenewals: number;
}

export interface InteractionState {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly policy: InputPolicyMode;
  readonly version: number;
  readonly guard?: InteractionGuard;
}

export interface Session {
  readonly id: string;
  readonly generation: number;
  readonly shell: ShellKind;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  readonly ownerId: string;
  readonly lineage?: SessionLineage;
  status: SessionStatus;
  activeExecutionId?: string;
  screenVersion: number;
  actionSequence: number;
  eventSequence: number;
  closedAt?: string;
}

export interface SessionLineage {
  readonly checkpointHash: string;
  readonly checkpointVersion: number;
  readonly forkedAt: string;
  readonly parentGeneration: number;
  readonly parentSessionId: string;
}

export interface ShellCheckpoint {
  readonly contentHash: string;
  readonly cwd: string;
  readonly filteredEnvironment: Readonly<Record<string, string>>;
  readonly observedAt: string;
  readonly sessionId: string;
  readonly shell: ShellKind;
  readonly sourceGeneration: number;
  readonly version: number;
  readonly workspaceRoot: string;
}

export interface ShellCheckpointView {
  readonly ageMilliseconds: number;
  readonly contentHash: string;
  readonly cwd: string;
  readonly environmentKeys: readonly string[];
  readonly observedAt: string;
  readonly sessionId: string;
  readonly shell: ShellKind;
  readonly sourceGeneration: number;
  readonly sourceStatus: SessionStatus;
  readonly stale: boolean;
  readonly version: number;
  readonly workspaceRoot: string;
}

export type SessionForkLimitation =
  | "process_state_not_copied"
  | "repl_editor_state_not_copied"
  | "shell_implicit_state_not_copied"
  | "workspace_filesystem_shared"
  | "filtered_environment_only";

export interface SessionForkResult {
  readonly checkpoint: ShellCheckpointView;
  readonly limitations: readonly SessionForkLimitation[];
  readonly replayed: boolean;
  readonly session: Session;
}

export interface Execution {
  readonly id: string;
  readonly actionId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly command: string;
  readonly actor: Actor;
  readonly createdAt: string;
  version: number;
  status: ExecutionStatus;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  cwd?: string;
  output?: string;
  outputTruncated?: boolean;
  interruptedRequested?: boolean;
}

interface ActionBase {
  readonly id: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly actor: Actor;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly actionSequence: number;
  readonly acceptedAt: string;
}

export interface ExecuteAction extends ActionBase {
  readonly type: "execute";
  readonly approvalId?: string;
  readonly command: string;
  readonly executionId: string;
  status: ExecuteActionStatus;
}

export interface InputAction extends ActionBase {
  readonly type: "input";
  readonly targetExecutionId: string;
  readonly data: string;
  readonly expectedScreenVersion?: number;
  status: InteractionActionStatus;
}

export interface ControlAction extends ActionBase {
  readonly type: "control";
  readonly targetExecutionId: string;
  readonly delivery: ControlDelivery;
  readonly bypassGuard: boolean;
  status: InteractionActionStatus;
}

export interface ResizeAction extends ActionBase {
  readonly type: "resize";
  readonly columns: number;
  readonly expectedGeometryVersion: number;
  readonly rows: number;
  status: InteractionActionStatus;
}

export type SessionAction = ExecuteAction | InputAction | ControlAction | ResizeAction;

export interface Approval {
  readonly actionIdempotencyKey: string;
  readonly actionRequestHash: string;
  readonly command: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly operation: "execution.start";
  readonly reason: string;
  readonly requestHash: string;
  readonly requestIdempotencyKey: string;
  readonly requestedAt: string;
  readonly requester: Actor;
  readonly sessionGeneration: number;
  readonly sessionId: string;
  status: ApprovalStatus;
  version: number;
  approver?: Actor;
  consumedActionId?: string;
  consumedAt?: string;
  decidedAt?: string;
  decisionIdempotencyKey?: string;
  decisionReason?: string;
  decisionRequestHash?: string;
}

export interface SessionEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly sequence: number;
  readonly type: string;
  readonly observedAt: string;
  readonly actionId?: string;
  readonly executionId?: string;
  readonly actor?: Actor;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EventPage {
  readonly events: readonly SessionEvent[];
  readonly nextAfter?: number;
  readonly truncated: boolean;
}
