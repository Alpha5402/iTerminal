import { startRuntimeDaemon } from "../server.js";

const failpoint = process.env.ITERM_TEST_FAILPOINT;
const daemon = await startRuntimeDaemon({
  databaseUrl: requiredEnvironment("ITERM_DATABASE_URL"),
  executionDispatch: "external",
  hooks: {
    ...(failpoint === "after-write"
      ? { afterExecutionWrite: () => process.kill(process.pid, "SIGKILL") }
      : {}),
    ...(failpoint === "before-finish-persist"
      ? { beforeExecutionFinishPersist: () => process.kill(process.pid, "SIGKILL") }
      : {}),
  },
  ownerId: requiredEnvironment("ITERM_RUNTIME_OWNER_ID"),
  socketPath: requiredEnvironment("ITERM_RUNTIME_SOCKET"),
});
process.stderr.write("external-dispatch daemon ready\n");

const shutdown = async (): Promise<void> => daemon.close();
process.once("SIGINT", () => void shutdown().then(() => process.exit(130)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
