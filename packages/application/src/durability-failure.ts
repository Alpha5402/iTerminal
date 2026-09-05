import { RuntimeError, type RuntimeErrorCode } from "@iterminal/domain";

import type { SessionFence } from "./ports.js";

export type DurabilityFailureScope =
  | Readonly<{ kind: "owner" }>
  | Readonly<{
      failureRecord: "committed" | "not_committed";
      fencingToken: string;
      generation: number;
      kind: "session";
      sessionId: string;
    }>;

const trustedDurabilityFailures = new WeakSet<RuntimeError>();

export function sessionDurabilityFailure(
  code: Extract<RuntimeErrorCode, "RUNTIME_UNAVAILABLE" | "SESSION_LEASE_LOST">,
  message: string,
  fence: SessionFence,
  options: Readonly<{
    details?: Readonly<Record<string, unknown>>;
    failureRecord: "committed" | "not_committed";
    retryable?: boolean;
  }>,
): RuntimeError {
  const scope: Extract<DurabilityFailureScope, { kind: "session" }> = Object.freeze({
    failureRecord: options.failureRecord,
    fencingToken: fence.fencingToken,
    generation: fence.generation,
    kind: "session",
    sessionId: fence.sessionId,
  });
  const error = new RuntimeError(
    code,
    message,
    {
      ...options.details,
      durabilityFailureScope: scope,
      fencingToken: fence.fencingToken,
      generation: fence.generation,
      sessionId: fence.sessionId,
    },
    options.retryable ?? false,
  );
  trustedDurabilityFailures.add(error);
  return error;
}

export function trustedDurabilityFailureScope(error: unknown): DurabilityFailureScope | undefined {
  if (!(error instanceof RuntimeError) || !trustedDurabilityFailures.has(error)) return undefined;
  const scope = error.details.durabilityFailureScope;
  if (typeof scope !== "object" || scope === null || !("kind" in scope)) return undefined;
  return scope as DurabilityFailureScope;
}
