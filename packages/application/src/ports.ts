import type {
  ControlDelivery,
  Execution,
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
  markSessionRunning(sessionId: string, generation: number, executionId: string): Session;
  releaseSession(sessionId: string, generation: number, executionId: string): Session;
  breakSession(sessionId: string, generation: number): Session;
  closeSession(sessionId: string, generation: number): Session;
  bumpScreenVersion(sessionId: string, generation: number): number;
  nextActionSequence(sessionId: string, generation: number): number;
  saveAction(action: SessionAction): void;
  getActionByIdempotency(scope: string, idempotencyKey: string): SessionAction | undefined;
  bindIdempotency(scope: string, idempotencyKey: string, actionId: string): void;
  getAction(actionId: string): SessionAction | undefined;
  saveExecution(execution: Execution): void;
  getExecution(executionId: string): Execution | undefined;
  appendEvent(
    sessionId: string,
    generation: number,
    event: Omit<SessionEvent, "id" | "sequence">,
  ): SessionEvent;
  queryEvents(
    sessionId: string,
    generation: number,
    after: number,
    limit: number,
  ): readonly SessionEvent[];
}
