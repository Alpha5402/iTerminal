import { RuntimeError } from "@iterminal/domain";
import { DEFAULT_RUNTIME_RETENTION_LIMITS, type RuntimeRetentionLimits } from "./ports.js";
export function runtimeRetentionLimits(
  configured: Partial<RuntimeRetentionLimits> | undefined,
): RuntimeRetentionLimits {
  const limits = { ...DEFAULT_RUNTIME_RETENTION_LIMITS, ...configured };
  for (const [name, value] of Object.entries(limits)) {
    requirePositiveInteger(value, `retention.${name}`);
  }
  if (
    limits.memoryOnlyControlReserveEntries >= limits.memoryOnlyActionEntries ||
    limits.memoryOnlyControlReserveBytes >= limits.memoryOnlyActionBytes
  ) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Memory-only Control reserve must be smaller than total Action capacity",
    );
  }
  return limits;
}

export function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeError("INVALID_REQUEST", `${name} must be a positive integer`, {
      [name]: value,
    });
  }
  return value;
}
