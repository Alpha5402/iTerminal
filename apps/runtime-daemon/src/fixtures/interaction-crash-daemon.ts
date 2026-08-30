import { startRuntimeDaemon } from "../server.js";

const failpoint = requiredEnvironment("ITERM_TEST_FAILPOINT");
const daemon = await startRuntimeDaemon({
  databaseHealthCheckMilliseconds: requiredPositiveInteger("ITERM_DATABASE_HEALTH_CHECK_MS"),
  databaseUrl: requiredEnvironment("ITERM_DATABASE_URL"),
  hooks: {
    ...(failpoint === "after-input-write"
      ? { afterInputWrite: () => process.kill(process.pid, "SIGKILL") }
      : {}),
    ...(failpoint === "after-control-write"
      ? { afterControlWrite: () => process.kill(process.pid, "SIGKILL") }
      : {}),
  },
  ownerId: requiredEnvironment("ITERM_RUNTIME_OWNER_ID"),
  ownerLeaseMilliseconds: requiredPositiveInteger("ITERM_RUNTIME_OWNER_LEASE_MS"),
  socketPath: requiredEnvironment("ITERM_RUNTIME_SOCKET"),
});
process.stderr.write("interaction-crash daemon ready\n");

const shutdown = async (): Promise<void> => daemon.close();
process.once("SIGINT", () => void shutdown().then(() => process.exit(130)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredPositiveInteger(name: string): number {
  const raw = requiredEnvironment(name);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || value.toString() !== raw) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
