import { randomUUID } from "node:crypto";

import { OutboxRelay } from "@iterminal/messaging";
import { PostgresMessagingRepository } from "@iterminal/persistence-postgres";
import {
  runtimeQueueTopology,
  SupervisedRabbitMqPublisher,
  type RabbitMqConnectionState,
} from "@iterminal/queue-rabbitmq";

const databaseUrl = requiredEnvironment("ITERM_DATABASE_URL");
const rabbitMqUrl = requiredEnvironment("ITERM_RABBITMQ_URL");
const publisherId = process.env.ITERM_PUBLISHER_ID ?? `publisher_${randomUUID()}`;
const topology = runtimeQueueTopology(process.env.ITERM_QUEUE_PREFIX ?? "iterminal");
const repository = new PostgresMessagingRepository(databaseUrl);
await repository.migrate();
const publisher = new SupervisedRabbitMqPublisher(rabbitMqUrl, topology, {
  ...(process.env.ITERM_RABBITMQ_RECONNECT_INITIAL_MS === undefined
    ? {}
    : {
        initialDelayMilliseconds: positiveInteger("ITERM_RABBITMQ_RECONNECT_INITIAL_MS"),
      }),
  ...(process.env.ITERM_RABBITMQ_RECONNECT_MAX_MS === undefined
    ? {}
    : { maxDelayMilliseconds: positiveInteger("ITERM_RABBITMQ_RECONNECT_MAX_MS") }),
  onConnectionState: reportRabbitMqState,
});
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

function positiveInteger(name: string): number {
  const value = Number.parseInt(requiredEnvironment(name), 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function reportRabbitMqState(state: RabbitMqConnectionState): void {
  process.stderr.write(
    `iTerminal Outbox relay RabbitMQ ${state.state.toLowerCase()} attempt=${state.attempt.toString()}${
      state.retryInMilliseconds === undefined
        ? ""
        : ` retry_ms=${state.retryInMilliseconds.toString()}`
    }${state.error === undefined ? "" : ` error=${JSON.stringify(state.error)}`}\n`,
  );
}
