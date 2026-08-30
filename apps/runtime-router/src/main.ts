import { defaultRuntimeRouterSocketPath, startRuntimeRouter } from "./server.js";

const router = await startRuntimeRouter({
  databaseUrl: requiredEnvironment("ITERM_DATABASE_URL"),
  socketPath: process.env.ITERM_ROUTER_SOCKET ?? defaultRuntimeRouterSocketPath(),
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
