import { randomUUID } from "node:crypto";

import { OutboxRelay } from "@iterminal/messaging";
import { PostgresMessagingRepository } from "@iterminal/persistence-postgres";
import { RabbitMqPublisher, runtimeQueueTopology } from "@iterminal/queue-rabbitmq";

const databaseUrl = requiredEnvironment("ITERM_DATABASE_URL");
const rabbitMqUrl = requiredEnvironment("ITERM_RABBITMQ_URL");
const publisherId = process.env.ITERM_PUBLISHER_ID ?? `publisher_${randomUUID()}`;
const topology = runtimeQueueTopology(process.env.ITERM_QUEUE_PREFIX ?? "iterminal");
const repository = new PostgresMessagingRepository(databaseUrl);
await repository.migrate();
const publisher = await RabbitMqPublisher.connect(rabbitMqUrl, topology);
const relay = new OutboxRelay(publisherId, repository, publisher);
const abortController = new AbortController();

const stop = (): void => abortController.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.stderr.write(`iTerminal Outbox relay started as ${publisherId}\n`);

try {
  await relay.run(abortController.signal);
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await publisher.close();
  await repository.close();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
