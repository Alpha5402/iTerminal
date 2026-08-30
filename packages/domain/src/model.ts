export type ActorType = "human" | "agent" | "scheduler" | "system";
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
export type ExecutionStatus =
  "DISPATCHING" | "RUNNING" | "COMPLETED" | "FAILED" | "INTERRUPTED" | "UNKNOWN";
export type TtyControl = "CTRL_C" | "CTRL_D" | "CTRL_Z" | "ESC";
export type ProcessSignal = "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGTSTP" | "SIGCONT";
export type ControlDelivery =
  | Readonly<{ mode: "TTY_CONTROL"; control: TtyControl }>
  | Readonly<{ mode: "PROCESS_SIGNAL"; signal: ProcessSignal }>;

export const CANONICAL_TERMINAL_COLUMNS = 120;
export const CANONICAL_TERMINAL_ROWS = 40;
export const TERMINAL_SCREEN_HISTORY_ENTRIES = 64;

export interface TerminalScreenFrame {
  readonly buffer: "normal" | "alternate";
  readonly columns: number;
  readonly cursor: Readonly<{ column: number; row: number }>;
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
      reason: "future_version" | "history_unavailable";
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

export interface Actor {
  readonly id: string;
  readonly type: ActorType;
  readonly principal: string;
  readonly client: string;
}

export interface Session {
  readonly id: string;
  readonly generation: number;
  readonly shell: ShellKind;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  readonly ownerId: string;
  status: SessionStatus;
  activeExecutionId?: string;
  screenVersion: number;
  actionSequence: number;
  eventSequence: number;
  closedAt?: string;
}

export interface Execution {
  readonly id: string;
  readonly actionId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly command: string;
  readonly actor: Actor;
  readonly createdAt: string;
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
  status: InteractionActionStatus;
}

export type SessionAction = ExecuteAction | InputAction | ControlAction;

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
