import { defaultRuntimeSocketPath, startRuntimeDaemon } from "./server.js";

const socketPath = process.env.ITERM_RUNTIME_SOCKET ?? defaultRuntimeSocketPath();
const databaseUrl = process.env.ITERM_DATABASE_URL;
const ownerId = process.env.ITERM_RUNTIME_OWNER_ID;
const daemon = await startRuntimeDaemon({
  socketPath,
  ...(databaseUrl === undefined ? {} : { databaseUrl }),
  ...(ownerId === undefined ? {} : { ownerId }),
});
process.stderr.write(
  `iTerminal Runtime daemon listening at ${daemon.socketPath} (${daemon.durable ? "postgres" : "memory"})\n`,
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
