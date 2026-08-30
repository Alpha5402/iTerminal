import { startRuntimeDaemon } from "../server.js";

const ownerId = requiredEnvironment("ITERM_RUNTIME_OWNER_ID");
const daemon = await startRuntimeDaemon({
  beforeAcceptExecuteCommit: () => process.kill(process.pid, "SIGKILL"),
  databaseHealthCheckMilliseconds: 50,
  databaseUrl: requiredEnvironment("ITERM_DATABASE_URL"),
  executionDispatch: "external",
  ownerId,
  ownerLeaseMilliseconds: 500,
  sessionLeaseMilliseconds: 500,
  socketPath: requiredEnvironment("ITERM_RUNTIME_SOCKET"),
});
process.stderr.write("precommit-crash daemon ready\n");

const shutdown = async (): Promise<void> => {
  await daemon.close();
};
process.once("SIGINT", () => void shutdown().then(() => process.exit(130)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
