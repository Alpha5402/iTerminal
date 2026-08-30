import { randomUUID } from "node:crypto";

import { OutboxRelay, type OutboxRelayOptions as RelayOptions } from "@iterminal/messaging";
import {
  isPostgresAvailabilityError,
  SupervisedPostgresMessagingRepository,
  type PostgresConnectionState,
} from "@iterminal/persistence-postgres";
import {
  runtimeQueueTopology,
  SupervisedRabbitMqPublisher,
  type RabbitMqConnectionState,
  type RabbitMqEndpoints,
} from "@iterminal/queue-rabbitmq";

export interface OutboxRelayHandle {
  close(): Promise<void>;
  databaseState(): PostgresConnectionState;
  publisherConnectionState(): RabbitMqConnectionState;
  waitUntilClosed(): Promise<void>;
  waitUntilDatabaseReady(): Promise<void>;
}

export interface StartOutboxRelayOptions extends RelayOptions {
  readonly databaseConnectionTimeoutMilliseconds?: number;
  readonly databaseHealthCheckMilliseconds?: number;
  readonly databaseReconnectInitialMilliseconds?: number;
  readonly databaseReconnectJitterRatio?: number;
  readonly databaseReconnectMaxMilliseconds?: number;
  readonly databaseOperationTimeoutMilliseconds?: number;
  readonly databaseUrl: string;
  readonly onPostgresConnectionState?: (state: PostgresConnectionState) => void;
  readonly onRabbitMqConnectionState?: (state: RabbitMqConnectionState) => void;
  readonly publisherId?: string;
  readonly queuePrefix?: string;
  readonly rabbitMqHeartbeatSeconds?: number;
  readonly rabbitMqReconnectInitialMilliseconds?: number;
  readonly rabbitMqReconnectJitterRatio?: number;
  readonly rabbitMqReconnectMaxMilliseconds?: number;
  readonly rabbitMqUrl: RabbitMqEndpoints;
}

export async function startOutboxRelay(
  options: StartOutboxRelayOptions,
): Promise<OutboxRelayHandle> {
  let databaseState: PostgresConnectionState = { attempt: 0, state: "CONNECTING" };
  const repository = await SupervisedPostgresMessagingRepository.start(options.databaseUrl, {
    ...(options.databaseConnectionTimeoutMilliseconds === undefined
      ? {}
      : { connectionTimeoutMilliseconds: options.databaseConnectionTimeoutMilliseconds }),
    ...(options.databaseHealthCheckMilliseconds === undefined
      ? {}
      : { healthCheckMilliseconds: options.databaseHealthCheckMilliseconds }),
    ...(options.databaseReconnectInitialMilliseconds === undefined
      ? {}
      : { initialDelayMilliseconds: options.databaseReconnectInitialMilliseconds }),
    ...(options.databaseReconnectJitterRatio === undefined
      ? {}
      : { jitterRatio: options.databaseReconnectJitterRatio }),
    ...(options.databaseReconnectMaxMilliseconds === undefined
      ? {}
      : { maxDelayMilliseconds: options.databaseReconnectMaxMilliseconds }),
    ...(options.databaseOperationTimeoutMilliseconds === undefined
      ? {}
      : { operationTimeoutMilliseconds: options.databaseOperationTimeoutMilliseconds }),
    onConnectionState: (state) => {
      databaseState = state;
      options.onPostgresConnectionState?.(state);
    },
  });
  let publisherState: RabbitMqConnectionState = { attempt: 0, state: "DISCONNECTED" };
  const publisher = new SupervisedRabbitMqPublisher(
    options.rabbitMqUrl,
    runtimeQueueTopology(options.queuePrefix ?? "iterminal"),
    {
      ...(options.rabbitMqHeartbeatSeconds === undefined
        ? {}
        : { heartbeatSeconds: options.rabbitMqHeartbeatSeconds }),
      ...(options.rabbitMqReconnectInitialMilliseconds === undefined
        ? {}
        : { initialDelayMilliseconds: options.rabbitMqReconnectInitialMilliseconds }),
      ...(options.rabbitMqReconnectJitterRatio === undefined
        ? {}
        : { jitterRatio: options.rabbitMqReconnectJitterRatio }),
      ...(options.rabbitMqReconnectMaxMilliseconds === undefined
        ? {}
        : { maxDelayMilliseconds: options.rabbitMqReconnectMaxMilliseconds }),
      onConnectionState: (state) => {
        publisherState = state;
        options.onRabbitMqConnectionState?.(state);
      },
    },
  );
  const relay = new OutboxRelay(
    options.publisherId ?? `publisher_${randomUUID()}`,
    repository,
    publisher,
    {
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.leaseMilliseconds === undefined
        ? {}
        : { leaseMilliseconds: options.leaseMilliseconds }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.pollMilliseconds === undefined
        ? {}
        : { pollMilliseconds: options.pollMilliseconds }),
      ...(options.retryDelay === undefined ? {} : { retryDelay: options.retryDelay }),
    },
  );
  const abortController = new AbortController();
  const runPromise = runRelay(
    relay,
    repository,
    options.pollMilliseconds ?? 250,
    abortController.signal,
  );
  void runPromise.catch(() => undefined);
  let closePromise: Promise<void> | undefined;
  return {
    close: () => {
      abortController.abort();
      closePromise ??= closeRelay(runPromise, publisher, repository);
      return closePromise;
    },
    databaseState: () => databaseState,
    publisherConnectionState: () => publisherState,
    waitUntilClosed: () => runPromise,
    waitUntilDatabaseReady: () => repository.waitUntilConnected(),
  };
}

async function runRelay(
  relay: OutboxRelay,
  repository: SupervisedPostgresMessagingRepository,
  pollMilliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    if (!(await waitOrAbort(repository.waitUntilConnected(), signal))) break;
    try {
      const report = await relay.publishBatch();
      if (report.claimed === 0) await abortableDelay(pollMilliseconds, signal);
    } catch (error) {
      if (signal.aborted) break;
      if (isPostgresAvailabilityError(error)) continue;
      throw error;
    }
  }
}

async function closeRelay(
  runPromise: Promise<void>,
  publisher: SupervisedRabbitMqPublisher,
  repository: SupervisedPostgresMessagingRepository,
): Promise<void> {
  const results = await Promise.allSettled([runPromise, publisher.close(), repository.close()]);
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") errors.push(result.reason as unknown);
  }
  if (errors.length > 0) throw new AggregateError(errors, "Outbox relay did not close cleanly");
}

function waitOrAbort(work: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolveWait, rejectWait) => {
    const finish = (completed: boolean): void => {
      signal.removeEventListener("abort", onAbort);
      resolveWait(completed);
    };
    const onAbort = (): void => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    void work
      .then(() => finish(true), rejectWait)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
