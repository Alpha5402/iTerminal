import type {
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

export interface ShellExecutionResult {
  readonly exitCode: number;
  readonly cwd: string;
  readonly output: string;
  readonly outputTruncated: boolean;
}

export interface ShellExecuteCallbacks {
  readonly onStarted: (observedCommand: string) => void;
}

export interface ShellExecutor {
  readonly shellPid: number;
  readonly shell: ShellKind;
  execute(command: string, callbacks: ShellExecuteCallbacks): Promise<ShellExecutionResult>;
  writeInput(data: string): void;
  sendControl(delivery: ControlDelivery): void;
  close(): void;
}

export interface CreateExecutorOptions {
  readonly shell: ShellKind;
  readonly workspaceRoot: string;
  readonly onOutput: (data: string) => void;
}

export interface ShellExecutorFactory {
  create(options: CreateExecutorOptions): Promise<ShellExecutor>;
}

export interface RuntimeStore {
  createSession(session: Session): void;
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

export interface RuntimeDurability {
  createSession(session: Session, events: readonly DurableSessionEvent[]): Promise<void>;
  markSessionReady(session: Session, shellPid: number, event: DurableSessionEvent): Promise<void>;
  markSessionBroken(
    session: Session,
    events: readonly DurableSessionEvent[],
    reason: string,
  ): Promise<void>;
  closeSession(session: Session, event: DurableSessionEvent): Promise<void>;
  acceptExecute(input: DurableExecuteAdmission): Promise<DurableExecuteAdmissionResult>;
  markExecutionRunning(input: {
    readonly session: Session;
    readonly action: ExecuteAction;
    readonly execution: Execution;
    readonly event: DurableSessionEvent;
  }): Promise<void>;
  finishExecution(input: {
    readonly session: Session;
    readonly action: ExecuteAction;
    readonly execution: Execution;
    readonly events: readonly DurableSessionEvent[];
  }): Promise<void>;
  failExecution(input: {
    readonly session: Session;
    readonly action: ExecuteAction;
    readonly execution: Execution;
    readonly events: readonly DurableSessionEvent[];
    readonly reason: string;
  }): Promise<void>;
  acceptInteraction(action: InputAction | ControlAction, event: DurableSessionEvent): Promise<void>;
  finishInteraction(action: InputAction | ControlAction, event: DurableSessionEvent): Promise<void>;
  appendEvent(event: DurableSessionEvent): Promise<void>;
  queryEvents(
    sessionId: string,
    generation: number,
    after: number,
    limit: number,
  ): Promise<EventPage>;
  recoverOwner(
    ownerId: string,
    reason: string,
  ): Promise<{
    readonly brokenSessions: number;
    readonly unknownExecutions: number;
  }>;
}

export interface RuntimeServiceOptions {
  readonly durability?: RuntimeDurability;
  readonly ownerId?: string;
  readonly now?: () => Date;
}
