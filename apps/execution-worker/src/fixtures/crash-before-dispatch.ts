import { startExecutionWorker } from "../server.js";

await startExecutionWorker({
  beforeDispatch: () => process.kill(process.pid, "SIGKILL"),
  consumerId: requiredEnvironment("ITERM_CONSUMER_ID"),
  databaseUrl: requiredEnvironment("ITERM_DATABASE_URL"),
  inboxLeaseMilliseconds: Number.parseInt(requiredEnvironment("ITERM_INBOX_LEASE_MS"), 10),
  ownerId: requiredEnvironment("ITERM_RUNTIME_OWNER_ID"),
  queuePrefix: requiredEnvironment("ITERM_QUEUE_PREFIX"),
  rabbitMqUrl: requiredEnvironment("ITERM_RABBITMQ_URL"),
  runtimeSocketPath: requiredEnvironment("ITERM_RUNTIME_SOCKET"),
});
process.stderr.write("crash-before-dispatch worker ready\n");

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
