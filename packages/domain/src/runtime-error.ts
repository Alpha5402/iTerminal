export type RuntimeErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_READY"
  | "SESSION_BROKEN"
  | "SESSION_GENERATION_CHANGED"
  | "PTY_BUSY"
  | "EXECUTION_CHANGED"
  | "SCREEN_CHANGED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "DELIVERY_UNKNOWN"
  | "RUNTIME_UNAVAILABLE"
  | "RESYNC_REQUIRED"
  | "INVALID_REQUEST"
  | "EXECUTION_NOT_FOUND";

export class RuntimeError extends Error {
  public constructor(
    public readonly code: RuntimeErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}
