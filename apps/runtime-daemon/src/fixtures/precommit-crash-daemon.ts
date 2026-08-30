import { RuntimeService } from "@iterminal/application";
import { PtyShellExecutorFactory } from "@iterminal/executor-pty";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";

import { startRuntimeDaemon } from "../server.js";

const ownerId = requiredEnvironment("ITERM_RUNTIME_OWNER_ID");
const durability = new PostgresRuntimeDurability(requiredEnvironment("ITERM_DATABASE_URL"), {
  beforeAcceptExecuteCommit: () => process.kill(process.pid, "SIGKILL"),
});
await durability.migrate();
const runtime = new RuntimeService(new MemoryRuntimeStore(), new PtyShellExecutorFactory(), {
  durability,
  executionDispatch: "external",
  ownerId,
});
const daemon = await startRuntimeDaemon({
  runtime,
  socketPath: requiredEnvironment("ITERM_RUNTIME_SOCKET"),
});
process.stderr.write("precommit-crash daemon ready\n");

const shutdown = async (): Promise<void> => {
  await daemon.close();
  await durability.close();
};
process.once("SIGINT", () => void shutdown().then(() => process.exit(130)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
