const POSTGRES_SQLSTATE = /^[0-9A-Z]{5}$/u;
const SAFE_OPERATIONAL_ERROR_CODES = new Set([
  "BACKPRESSURE",
  "DELIVERY_UNKNOWN",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "EPERM",
  "ETIMEDOUT",
  "OWNER_LEASE_LOST",
  "OWNER_ROUTE_UNAVAILABLE",
  "RUNTIME_UNAVAILABLE",
  "SESSION_LEASE_LOST",
]);

/**
 * Produces an ordinary-telemetry-safe failure summary without reading attacker- or
 * dependency-controlled error text. The fallback must be a fixed, programmer-owned string.
 */
export function operationalErrorMessage(error: unknown, fallback: string): string {
  const code = operationalErrorCode(error);
  return code === undefined ? fallback : `${fallback} (${code})`;
}

export function operationalErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  const code = descriptor?.value as unknown;
  if (
    typeof code !== "string" ||
    (!SAFE_OPERATIONAL_ERROR_CODES.has(code) && !POSTGRES_SQLSTATE.test(code))
  ) {
    return undefined;
  }
  return code;
}
