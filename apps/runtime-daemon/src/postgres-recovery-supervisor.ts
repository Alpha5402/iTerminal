import type {
  RuntimeOwnerRecord,
  RuntimeOwnerRegistry,
  RuntimeService,
} from "@iterminal/application";
import { RuntimeError } from "@iterminal/domain";
import type { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";

export interface RuntimeDaemonDurabilityState {
  readonly attempt: number;
  readonly endpointIndex?: number;
  readonly error?: string;
  readonly phase: "CONNECTING" | "DISABLED" | "READY" | "UNAVAILABLE";
  readonly retryInMilliseconds?: number;
}

export interface PostgresRecoverySupervisor {
  readonly firstAttempt: Promise<void>;
  ownerRegistration(): RuntimeOwnerRecord | undefined;
  close(): Promise<void>;
}

export function startPostgresRecoverySupervisor(options: {
  readonly durability: PostgresRuntimeDurability;
  readonly healthCheckMilliseconds?: number;
  readonly initialDelayMilliseconds?: number;
  readonly jitterRatio?: number;
  readonly maxDelayMilliseconds?: number;
  readonly onOwnerLeaseConfirmed?: (remainingLeaseMilliseconds: number) => Promise<void>;
  readonly ownership?: {
    readonly capacityWeight: number;
    readonly endpoint: string;
    readonly instanceId: string;
    readonly leaseMilliseconds: number;
    readonly ownerId: string;
    readonly registry: RuntimeOwnerRegistry;
  };
  readonly runtime: RuntimeService;
  readonly updateState: (state: RuntimeDaemonDurabilityState) => void;
}): PostgresRecoverySupervisor {
  const initialDelayMilliseconds = positiveInteger(
    options.initialDelayMilliseconds ?? 250,
    "databaseReconnectInitialMilliseconds",
  );
  const maxDelayMilliseconds = positiveInteger(
    options.maxDelayMilliseconds ?? Math.max(30_000, initialDelayMilliseconds),
    "databaseReconnectMaxMilliseconds",
  );
  if (maxDelayMilliseconds < initialDelayMilliseconds) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Database reconnect maximum delay cannot be below its initial delay",
    );
  }
  const jitterRatio = options.jitterRatio ?? 0.2;
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Database reconnect jitter ratio must be between zero and one",
    );
  }
  const healthCheckMilliseconds = positiveInteger(
    options.healthCheckMilliseconds ?? 1_000,
    "databaseHealthCheckMilliseconds",
  );
  const abortController = new AbortController();
  let resolveFirstAttempt!: () => void;
  const firstAttempt = new Promise<void>((resolve) => {
    resolveFirstAttempt = resolve;
  });
  let firstAttemptFinished = false;
  let closePromise: Promise<void> | undefined;
  let ownerRegistration: RuntimeOwnerRecord | undefined;
  const run = (async (): Promise<void> => {
    let attempt = 0;
    let recoveredOnce = false;
    while (!abortController.signal.aborted) {
      if (recoveredOnce && options.runtime.isDurabilityHealthy()) {
        await abortableDelay(healthCheckMilliseconds, abortController.signal);
        if (abortController.signal.aborted) continue;
        try {
          if (options.ownership === undefined) {
            await options.durability.healthCheck();
          } else {
            const renewalStartedAt = performance.now();
            ownerRegistration = await options.ownership.registry.heartbeatOwner(
              ownerRegistration ?? missingOwnerRegistration(),
              options.ownership.leaseMilliseconds,
            );
            options.runtime.activateDurableOwner(ownerRegistration);
            await options.runtime.renewDurableSessionLeases();
            await options.onOwnerLeaseConfirmed?.(
              remainingLeaseMilliseconds(options.ownership.leaseMilliseconds, renewalStartedAt),
            );
          }
        } catch (error) {
          options.runtime.reportDurabilityUnavailable(error);
          options.updateState({
            attempt: 0,
            endpointIndex: options.durability.databaseEndpointIndex(),
            error: errorMessage(error),
            phase: "UNAVAILABLE",
          });
        }
        continue;
      }
      attempt += 1;
      options.updateState({
        attempt,
        endpointIndex: options.durability.databaseEndpointIndex(),
        phase: "CONNECTING",
      });
      try {
        await options.durability.migrate();
        await options.durability.healthCheck();
        if (options.ownership !== undefined) {
          ownerRegistration = await options.ownership.registry.registerOwner({
            capacityWeight: options.ownership.capacityWeight,
            endpoint: options.ownership.endpoint,
            instanceId: options.ownership.instanceId,
            leaseMilliseconds: options.ownership.leaseMilliseconds,
            ownerId: options.ownership.ownerId,
          });
          options.runtime.activateDurableOwner(ownerRegistration);
        }
        await options.runtime.recoverDurableOwner(
          recoveredOnce
            ? "PostgreSQL outage invalidated Runtime owner"
            : "runtime owner restarted without a graceful close",
        );
        if (options.ownership !== undefined) {
          const renewalStartedAt = performance.now();
          ownerRegistration = await options.ownership.registry.heartbeatOwner(
            ownerRegistration ?? missingOwnerRegistration(),
            options.ownership.leaseMilliseconds,
          );
          options.runtime.activateDurableOwner(ownerRegistration);
          await options.runtime.renewDurableSessionLeases();
          await options.onOwnerLeaseConfirmed?.(
            remainingLeaseMilliseconds(options.ownership.leaseMilliseconds, renewalStartedAt),
          );
        }
        recoveredOnce = true;
        attempt = 0;
        options.updateState({
          attempt: 0,
          endpointIndex: options.durability.databaseEndpointIndex(),
          phase: "READY",
        });
      } catch (error) {
        const retryInMilliseconds = reconnectDelay(
          attempt,
          initialDelayMilliseconds,
          maxDelayMilliseconds,
          jitterRatio,
        );
        options.updateState({
          attempt,
          endpointIndex: options.durability.databaseEndpointIndex(),
          error: errorMessage(error),
          phase: "UNAVAILABLE",
          retryInMilliseconds,
        });
        await abortableDelay(retryInMilliseconds, abortController.signal);
      } finally {
        if (!firstAttemptFinished) {
          firstAttemptFinished = true;
          resolveFirstAttempt();
        }
      }
    }
  })();
  return {
    firstAttempt,
    ownerRegistration: () => ownerRegistration,
    close: () => {
      closePromise ??= (async () => {
        abortController.abort();
        await run;
      })();
      return closePromise;
    },
  };
}

function remainingLeaseMilliseconds(leaseMilliseconds: number, startedAt: number): number {
  return Math.max(1, leaseMilliseconds - Math.ceil(performance.now() - startedAt));
}

function missingOwnerRegistration(): never {
  throw new RuntimeError(
    "OWNER_LEASE_LOST",
    "Runtime owner heartbeat has no registered owner identity",
    {},
    false,
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeError("INVALID_REQUEST", `${name} must be a positive integer`, {
      [name]: value,
    });
  }
  return value;
}

function reconnectDelay(
  attempt: number,
  initialDelayMilliseconds: number,
  maxDelayMilliseconds: number,
  jitterRatio: number,
): number {
  const exponential = Math.min(
    maxDelayMilliseconds,
    initialDelayMilliseconds * 2 ** Math.max(0, Math.min(attempt - 1, 20)),
  );
  const jitter = exponential * jitterRatio * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(exponential + jitter));
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
