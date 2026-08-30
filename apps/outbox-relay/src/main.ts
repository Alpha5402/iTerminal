import type { PostgresConnectionState } from "@iterminal/persistence-postgres";
import type { RabbitMqConnectionState } from "@iterminal/queue-rabbitmq";

import { startOutboxRelay } from "./server.js";

const databaseUrl = requiredEnvironment("ITERM_DATABASE_URL");
const rabbitMqUrl = requiredEnvironment("ITERM_RABBITMQ_URL");
const relay = await startOutboxRelay({
  databaseUrl,
  rabbitMqUrl,
  ...(process.env.ITERM_PUBLISHER_ID === undefined
    ? {}
    : { publisherId: process.env.ITERM_PUBLISHER_ID }),
  ...(process.env.ITERM_QUEUE_PREFIX === undefined
    ? {}
    : { queuePrefix: process.env.ITERM_QUEUE_PREFIX }),
  ...(process.env.ITERM_RABBITMQ_RECONNECT_INITIAL_MS === undefined
    ? {}
    : {
        rabbitMqReconnectInitialMilliseconds: positiveInteger(
          "ITERM_RABBITMQ_RECONNECT_INITIAL_MS",
        ),
      }),
  ...(process.env.ITERM_RABBITMQ_RECONNECT_MAX_MS === undefined
    ? {}
    : {
        rabbitMqReconnectMaxMilliseconds: positiveInteger("ITERM_RABBITMQ_RECONNECT_MAX_MS"),
      }),
  ...(process.env.ITERM_DATABASE_HEALTH_CHECK_MS === undefined
    ? {}
    : { databaseHealthCheckMilliseconds: positiveInteger("ITERM_DATABASE_HEALTH_CHECK_MS") }),
  ...(process.env.ITERM_DATABASE_RECONNECT_INITIAL_MS === undefined
    ? {}
    : {
        databaseReconnectInitialMilliseconds: positiveInteger(
          "ITERM_DATABASE_RECONNECT_INITIAL_MS",
        ),
      }),
  ...(process.env.ITERM_DATABASE_RECONNECT_MAX_MS === undefined
    ? {}
    : {
        databaseReconnectMaxMilliseconds: positiveInteger("ITERM_DATABASE_RECONNECT_MAX_MS"),
      }),
  onPostgresConnectionState: reportPostgresState,
  onRabbitMqConnectionState: reportRabbitMqState,
});

let signalExitCode: number | undefined;
const stop = (exitCode: number): void => {
  signalExitCode ??= exitCode;
  void relay.close().catch(() => undefined);
};
const stopForInterrupt = (): void => stop(130);
const stopForTermination = (): void => stop(0);
process.once("SIGINT", stopForInterrupt);
process.once("SIGTERM", stopForTermination);
process.stderr.write("iTerminal Outbox relay started\n");

try {
  await relay.waitUntilClosed();
} finally {
  process.off("SIGINT", stopForInterrupt);
  process.off("SIGTERM", stopForTermination);
  await relay.close();
}
if (signalExitCode !== undefined) process.exitCode = signalExitCode;

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

function reportPostgresState(state: PostgresConnectionState): void {
  process.stderr.write(
    `iTerminal Outbox relay PostgreSQL ${state.state.toLowerCase()} attempt=${state.attempt.toString()}${
      state.retryInMilliseconds === undefined
        ? ""
        : ` retry_ms=${state.retryInMilliseconds.toString()}`
    }${state.error === undefined ? "" : ` error=${JSON.stringify(state.error)}`}\n`,
  );
}
