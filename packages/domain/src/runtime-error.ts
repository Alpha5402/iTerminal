export type RuntimeErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_READY"
  | "SESSION_BROKEN"
  | "SESSION_GENERATION_CHANGED"
  | "PTY_BUSY"
  | "EXECUTION_CHANGED"
  | "SCREEN_CHANGED"
  | "GEOMETRY_CHANGED"
  | "CHECKPOINT_NOT_FOUND"
  | "CHECKPOINT_CHANGED"
  | "CHECKPOINT_STALE"
  | "CHECKPOINT_INVALID"
  | "INPUT_GUARDED"
  | "INTERACTION_GUARD_CHANGED"
  | "POLICY_DENIED"
  | "ACTOR_IDENTITY_CONFLICT"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_CHANGED"
  | "APPROVAL_REQUIRED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "DELIVERY_UNKNOWN"
  | "BACKPRESSURE"
  | "RATE_LIMITED"
  | "OWNER_CONFLICT"
  | "OWNER_LEASE_LOST"
  | "OWNER_ROUTE_UNAVAILABLE"
  | "SESSION_LEASE_LOST"
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
