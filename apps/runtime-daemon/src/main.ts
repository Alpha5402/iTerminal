import {
  defaultRuntimeSocketPath,
  startRuntimeDaemon,
  type RuntimeDaemonDurabilityState,
} from "./server.js";

const socketPath = process.env.ITERM_RUNTIME_SOCKET ?? defaultRuntimeSocketPath();
const databaseUrl = process.env.ITERM_DATABASE_URL;
const ownerId = process.env.ITERM_RUNTIME_OWNER_ID;
const executionDispatch = parseExecutionDispatch(process.env.ITERM_EXECUTION_DISPATCH);
const databaseStatementTimeoutMilliseconds = optionalPositiveInteger(
  "ITERM_DATABASE_STATEMENT_TIMEOUT_MS",
);
const outboxMaxPending = optionalPositiveInteger("ITERM_OUTBOX_MAX_PENDING");
const databaseReconnectInitialMilliseconds = optionalPositiveInteger(
  "ITERM_DATABASE_RECONNECT_INITIAL_MS",
);
const databaseReconnectMaxMilliseconds = optionalPositiveInteger("ITERM_DATABASE_RECONNECT_MAX_MS");
const databaseHealthCheckMilliseconds = optionalPositiveInteger("ITERM_DATABASE_HEALTH_CHECK_MS");
const daemon = await startRuntimeDaemon({
  socketPath,
  ...(databaseUrl === undefined ? {} : { databaseUrl }),
  ...(executionDispatch === undefined ? {} : { executionDispatch }),
  ...(databaseStatementTimeoutMilliseconds === undefined
    ? {}
    : { databaseStatementTimeoutMilliseconds }),
  ...(outboxMaxPending === undefined ? {} : { outboxMaxPending }),
  ...(databaseReconnectInitialMilliseconds === undefined
    ? {}
    : { databaseReconnectInitialMilliseconds }),
  ...(databaseReconnectMaxMilliseconds === undefined ? {} : { databaseReconnectMaxMilliseconds }),
  ...(databaseHealthCheckMilliseconds === undefined ? {} : { databaseHealthCheckMilliseconds }),
  ...(ownerId === undefined ? {} : { ownerId }),
  onDurabilityState: reportDurabilityState,
});
process.stderr.write(
  `iTerminal Runtime daemon listening at ${daemon.socketPath} (${daemon.durable ? `postgres:${daemon.durabilityState().phase.toLowerCase()}` : "memory"})\n`,
);

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  process.stderr.write(`iTerminal Runtime daemon stopping after ${signal}\n`);
  await daemon.close();
};

process.on("SIGINT", () => {
  void shutdown("SIGINT").then(() => process.exit(130));
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => process.exit(0));
});

function parseExecutionDispatch(value: string | undefined): "external" | "immediate" | undefined {
  if (value === undefined) return undefined;
  if (value === "external" || value === "immediate") return value;
  throw new Error("ITERM_EXECUTION_DISPATCH must be 'external' or 'immediate'");
}

function optionalPositiveInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || value.toString() !== raw) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function reportDurabilityState(state: RuntimeDaemonDurabilityState): void {
  if (state.phase === "DISABLED") return;
  process.stderr.write(
    `iTerminal Runtime PostgreSQL ${state.phase.toLowerCase()} attempt=${state.attempt.toString()}${
      state.retryInMilliseconds === undefined
        ? ""
        : ` retry_ms=${state.retryInMilliseconds.toString()}`
    }${state.error === undefined ? "" : ` error=${JSON.stringify(state.error)}`}\n`,
  );
}
