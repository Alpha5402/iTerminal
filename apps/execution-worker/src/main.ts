import type { RabbitMqConnectionState } from "@iterminal/queue-rabbitmq";
import type { PostgresConnectionState } from "@iterminal/persistence-postgres";

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
  ...(process.env.ITERM_RABBITMQ_RECONNECT_INITIAL_MS === undefined
    ? {}
    : {
        rabbitMqReconnectInitialMilliseconds: positiveInteger(
          "ITERM_RABBITMQ_RECONNECT_INITIAL_MS",
        ),
      }),
  ...(process.env.ITERM_RABBITMQ_HEARTBEAT_SECONDS === undefined
    ? {}
    : { rabbitMqHeartbeatSeconds: positiveInteger("ITERM_RABBITMQ_HEARTBEAT_SECONDS") }),
  ...(process.env.ITERM_RABBITMQ_RECONNECT_MAX_MS === undefined
    ? {}
    : {
        rabbitMqReconnectMaxMilliseconds: positiveInteger("ITERM_RABBITMQ_RECONNECT_MAX_MS"),
      }),
  ...(process.env.ITERM_DATABASE_HEALTH_CHECK_MS === undefined
    ? {}
    : { databaseHealthCheckMilliseconds: positiveInteger("ITERM_DATABASE_HEALTH_CHECK_MS") }),
  ...(process.env.ITERM_DATABASE_CONNECTION_TIMEOUT_MS === undefined
    ? {}
    : {
        databaseConnectionTimeoutMilliseconds: positiveInteger(
          "ITERM_DATABASE_CONNECTION_TIMEOUT_MS",
        ),
      }),
  ...(process.env.ITERM_DATABASE_OPERATION_TIMEOUT_MS === undefined
    ? {}
    : {
        databaseOperationTimeoutMilliseconds: positiveInteger(
          "ITERM_DATABASE_OPERATION_TIMEOUT_MS",
        ),
      }),
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

let closing = false;
let signalExitCode: number | undefined;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await worker.close();
};
const stop = (exitCode: number): void => {
  signalExitCode ??= exitCode;
  void shutdown().catch(() => undefined);
};
const stopForInterrupt = (): void => stop(130);
const stopForTermination = (): void => stop(0);
process.once("SIGINT", stopForInterrupt);
process.once("SIGTERM", stopForTermination);
process.stderr.write("iTerminal Execution worker started\n");
try {
  await worker.waitUntilClosed();
} finally {
  process.off("SIGINT", stopForInterrupt);
  process.off("SIGTERM", stopForTermination);
  await worker.close();
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
    `iTerminal Execution worker RabbitMQ ${state.state.toLowerCase()} attempt=${state.attempt.toString()}${
      state.retryInMilliseconds === undefined
        ? ""
        : ` retry_ms=${state.retryInMilliseconds.toString()}`
    }${state.error === undefined ? "" : ` error=${JSON.stringify(state.error)}`}\n`,
  );
}

function reportPostgresState(state: PostgresConnectionState): void {
  process.stderr.write(
    `iTerminal Execution worker PostgreSQL ${state.state.toLowerCase()} attempt=${state.attempt.toString()}${
      state.retryInMilliseconds === undefined
        ? ""
        : ` retry_ms=${state.retryInMilliseconds.toString()}`
    }${state.error === undefined ? "" : ` error=${JSON.stringify(state.error)}`}\n`,
  );
}
