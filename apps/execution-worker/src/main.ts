import { startExecutionWorker } from "./server.js";

const worker = await startExecutionWorker({
  databaseUrl: requiredEnvironment("ITERM_DATABASE_URL"),
  rabbitMqUrl: requiredEnvironment("ITERM_RABBITMQ_URL"),
  runtimeSocketPath: requiredEnvironment("ITERM_RUNTIME_SOCKET"),
  ...(process.env.ITERM_CONSUMER_ID === undefined
    ? {}
    : { consumerId: process.env.ITERM_CONSUMER_ID }),
  ...(process.env.ITERM_INBOX_LEASE_MS === undefined
    ? {}
    : { inboxLeaseMilliseconds: positiveInteger("ITERM_INBOX_LEASE_MS") }),
  ...(process.env.ITERM_QUEUE_PREFIX === undefined
    ? {}
    : { queuePrefix: process.env.ITERM_QUEUE_PREFIX }),
  ...(process.env.ITERM_RUNTIME_OWNER_ID === undefined
    ? {}
    : { ownerId: process.env.ITERM_RUNTIME_OWNER_ID }),
});

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await worker.close();
};
process.once("SIGINT", () => void shutdown().then(() => process.exit(130)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.stderr.write("iTerminal Execution worker started\n");

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string): number {
  const value = Number.parseInt(requiredEnvironment(name), 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
