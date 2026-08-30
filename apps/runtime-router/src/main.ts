import type { RuntimeRouterDatabaseState } from "./postgres-recovery-supervisor.js";
import { defaultRuntimeRouterSocketPath, startRuntimeRouter } from "./server.js";

const router = await startRuntimeRouter({
  databaseUrl: requiredEnvironment("ITERM_DATABASE_URL"),
  superviseDatabase: true,
  onDatabaseState: reportDatabaseState,
  socketPath: process.env.ITERM_ROUTER_SOCKET ?? defaultRuntimeRouterSocketPath(),
  ...(process.env.ITERM_DATABASE_HEALTH_CHECK_MS === undefined
    ? {}
    : {
        databaseHealthCheckMilliseconds: positiveInteger("ITERM_DATABASE_HEALTH_CHECK_MS"),
      }),
  ...(process.env.ITERM_DATABASE_RECONNECT_INITIAL_MS === undefined
    ? {}
    : {
        databaseReconnectInitialMilliseconds: positiveInteger(
          "ITERM_DATABASE_RECONNECT_INITIAL_MS",
        ),
      }),
  ...(process.env.ITERM_DATABASE_RECONNECT_MAX_MS === undefined
    ? {}
    : {
        databaseReconnectMaxMilliseconds: positiveInteger("ITERM_DATABASE_RECONNECT_MAX_MS"),
      }),
  ...(process.env.ITERM_DATABASE_STATEMENT_TIMEOUT_MS === undefined
    ? {}
    : {
        databaseStatementTimeoutMilliseconds: positiveInteger(
          "ITERM_DATABASE_STATEMENT_TIMEOUT_MS",
        ),
      }),
});

process.stderr.write(`iTerminal Runtime Router listening at ${router.socketPath}\n`);

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  process.stderr.write(`iTerminal Runtime Router stopping after ${signal}\n`);
  await router.close();
};

process.on("SIGINT", () => {
  void shutdown("SIGINT").then(() => process.exit(130));
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => process.exit(0));
});

function reportDatabaseState(state: RuntimeRouterDatabaseState): void {
  if (state.phase === "READY") {
    process.stderr.write("iTerminal Runtime Router PostgreSQL ready\n");
    return;
  }
  if (state.phase === "UNAVAILABLE") {
    process.stderr.write(
      `iTerminal Runtime Router PostgreSQL unavailable; retrying in ${state.retryInMilliseconds?.toString() ?? "unknown"} ms\n`,
    );
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string): number {
  const raw = requiredEnvironment(name);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || value.toString() !== raw) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
