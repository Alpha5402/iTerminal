import { RuntimeError } from "@iterminal/domain";

export interface RuntimeRouterDatabaseState {
  readonly attempt: number;
  readonly endpointIndex?: number;
  readonly phase: "CONNECTING" | "READY" | "UNAVAILABLE";
  readonly retryInMilliseconds?: number;
}

export interface RuntimeRouterDatabaseGate {
  assertReady(operation: string): void;
  reportUnavailable(): void;
}

export interface RouterPostgresRecoverySupervisor {
  readonly gate: RuntimeRouterDatabaseGate;
  close(): Promise<void>;
  state(): RuntimeRouterDatabaseState;
}

export function startRouterPostgresRecoverySupervisor(options: {
  readonly database: {
    databaseEndpointIndex?(): number;
    healthCheck(): Promise<void>;
    migrate(): Promise<void>;
  };
  readonly healthCheckMilliseconds?: number;
  readonly initialDelayMilliseconds?: number;
  readonly jitterRatio?: number;
  readonly maxDelayMilliseconds?: number;
  readonly updateState?: (state: RuntimeRouterDatabaseState) => void;
}): RouterPostgresRecoverySupervisor {
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
  const healthCheckMilliseconds = positiveInteger(
    options.healthCheckMilliseconds ?? 1_000,
    "databaseHealthCheckMilliseconds",
  );
  const jitterRatio = options.jitterRatio ?? 0.2;
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Database reconnect jitter ratio must be between zero and one",
    );
  }
  const abortController = new AbortController();
  let current: RuntimeRouterDatabaseState = {
    attempt: 0,
    ...endpointState(options.database),
    phase: "CONNECTING",
  };
  let closePromise: Promise<void> | undefined;
  const update = (state: RuntimeRouterDatabaseState): void => {
    current = state;
    options.updateState?.(state);
  };
  const gate: RuntimeRouterDatabaseGate = {
    assertReady: (operation) => {
      if (current.phase === "READY") return;
      throw unavailable(operation, current);
    },
    reportUnavailable: () => {
      if (current.phase === "READY") {
        update({ attempt: 0, ...endpointState(options.database), phase: "UNAVAILABLE" });
      }
    },
  };
  const run = (async (): Promise<void> => {
    let attempt = 0;
    while (!abortController.signal.aborted) {
      if (current.phase === "READY") {
        await abortableDelay(healthCheckMilliseconds, abortController.signal);
        if (abortController.signal.aborted || current.phase !== "READY") continue;
        try {
          await options.database.healthCheck();
        } catch {
          update({
            attempt: 0,
            ...endpointState(options.database),
            phase: "UNAVAILABLE",
          });
        }
        continue;
      }
      attempt += 1;
      update({ attempt, ...endpointState(options.database), phase: "CONNECTING" });
      try {
        await options.database.migrate();
        attempt = 0;
        update({ attempt: 0, ...endpointState(options.database), phase: "READY" });
      } catch {
        const retryInMilliseconds = reconnectDelay(
          attempt,
          initialDelayMilliseconds,
          maxDelayMilliseconds,
          jitterRatio,
        );
        update({
          attempt,
          ...endpointState(options.database),
          phase: "UNAVAILABLE",
          retryInMilliseconds,
        });
        await abortableDelay(retryInMilliseconds, abortController.signal);
      }
    }
  })();
  return {
    gate,
    state: () => current,
    close: () => {
      closePromise ??= (async () => {
        abortController.abort();
        await run;
      })();
      return closePromise;
    },
  };
}

function unavailable(operation: string, state: RuntimeRouterDatabaseState): RuntimeError {
  return new RuntimeError(
    "RUNTIME_UNAVAILABLE",
    "Runtime Router durable route database is unavailable",
    {
      attempt: state.attempt,
      component: "runtime-router",
      databasePhase: state.phase,
      operation,
      phase: "route_resolution",
      ...(state.retryInMilliseconds === undefined
        ? {}
        : { retryInMilliseconds: state.retryInMilliseconds }),
      ...(state.endpointIndex === undefined ? {} : { endpointIndex: state.endpointIndex }),
    },
    true,
  );
}

function endpointState(database: { databaseEndpointIndex?(): number }): {
  readonly endpointIndex?: number;
} {
  const endpointIndex = database.databaseEndpointIndex?.();
  return endpointIndex === undefined ? {} : { endpointIndex };
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
