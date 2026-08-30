import { ExecutionReadyProcessor, type ExecutionReadyMessage } from "@iterminal/messaging";
import {
  SupervisedPostgresMessagingRepository,
  type PostgresConnectionState,
} from "@iterminal/persistence-postgres";
import {
  runtimeQueueTopology,
  SupervisedRabbitMqExecutionReadyConsumer,
  type RabbitMqConnectionState,
} from "@iterminal/queue-rabbitmq";
import { runtimeOwnerIdForSocket, UnixRuntimeClient } from "@iterminal/runtime-rpc";

export interface ExecutionWorkerHandle {
  connectionState(): RabbitMqConnectionState;
  close(): Promise<void>;
  databaseState(): PostgresConnectionState;
  waitUntilClosed(): Promise<void>;
  waitUntilConnected(): Promise<void>;
  waitUntilDatabaseReady(): Promise<void>;
}

export interface ExecutionWorkerOptions {
  readonly beforeDispatch?: (message: ExecutionReadyMessage) => void;
  readonly consumerId?: string;
  readonly databaseConnectionTimeoutMilliseconds?: number;
  readonly databaseHealthCheckMilliseconds?: number;
  readonly databaseReconnectInitialMilliseconds?: number;
  readonly databaseReconnectJitterRatio?: number;
  readonly databaseReconnectMaxMilliseconds?: number;
  readonly databaseOperationTimeoutMilliseconds?: number;
  readonly databaseUrl: string;
  readonly inboxLeaseMilliseconds?: number;
  readonly maxAttempts?: number;
  readonly ownerId?: string;
  readonly prefetch?: number;
  readonly queuePrefix?: string;
  readonly rabbitMqUrl: string;
  readonly rabbitMqHeartbeatSeconds?: number;
  readonly rabbitMqReconnectInitialMilliseconds?: number;
  readonly rabbitMqReconnectJitterRatio?: number;
  readonly rabbitMqReconnectMaxMilliseconds?: number;
  readonly onPostgresConnectionState?: (state: PostgresConnectionState) => void;
  readonly onRabbitMqConnectionState?: (state: RabbitMqConnectionState) => void;
  readonly runtimeSocketPath: string;
}

export async function startExecutionWorker(
  options: ExecutionWorkerOptions,
): Promise<ExecutionWorkerHandle> {
  const ownerId = options.ownerId ?? runtimeOwnerIdForSocket(options.runtimeSocketPath);
  const consumerId = options.consumerId ?? `execution-worker:${ownerId}`;
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
  const runtime = new UnixRuntimeClient(options.runtimeSocketPath);
  const processor = new ExecutionReadyProcessor(
    consumerId,
    repository,
    repository,
    async (message, inspection) => {
      if (inspection.ownerId !== ownerId) {
        throw new Error(
          `Execution belongs to ${inspection.ownerId}, but this Worker serves ${ownerId}`,
        );
      }
      options.beforeDispatch?.(message);
      await runtime.dispatchExecution(message.payload.executionId);
    },
    {
      ...(options.inboxLeaseMilliseconds === undefined
        ? {}
        : { inboxLeaseMilliseconds: options.inboxLeaseMilliseconds }),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    },
  );
  let connectionState: RabbitMqConnectionState = { attempt: 0, state: "DISCONNECTED" };
  const connectedWaiters = new Set<Deferred<void>>();
  const closed = deferred<void>();
  const abortController = new AbortController();
  let activeConsumer: SupervisedRabbitMqExecutionReadyConsumer | undefined;
  let closing = false;
  const isConnected = (): boolean =>
    !closing && databaseState.state === "CONNECTED" && connectionState.state === "CONNECTED";
  const updateRabbitMqState = (state: RabbitMqConnectionState): void => {
    connectionState = state;
    try {
      options.onRabbitMqConnectionState?.(state);
    } catch {
      // Diagnostics must not change Worker behavior.
    }
    if (isConnected()) {
      for (const waiter of connectedWaiters) waiter.resolve();
      connectedWaiters.clear();
    }
  };
  const lifecycle = runConsumerLifecycle({
    abortController,
    onActiveConsumer: (consumer) => {
      activeConsumer = consumer;
    },
    options,
    processor,
    repository,
    updateRabbitMqState,
  });
  void lifecycle.catch((error: unknown) => closed.reject(error));
  let closePromise: Promise<void> | undefined;
  return {
    connectionState: () => connectionState,
    databaseState: () => databaseState,
    close: () => {
      if (!closing) {
        closing = true;
        abortController.abort();
        const error = new Error("Execution Worker closed before becoming ready");
        for (const waiter of connectedWaiters) waiter.reject(error);
        connectedWaiters.clear();
      }
      closePromise ??= closeWorker(lifecycle, activeConsumer, repository).then(
        () => closed.resolve(),
        (error: unknown) => {
          closed.reject(error);
          throw error;
        },
      );
      return closePromise;
    },
    waitUntilClosed: () => closed.promise,
    waitUntilConnected: () => {
      if (isConnected()) return Promise.resolve();
      if (closing) return Promise.reject(new Error("Execution Worker is closed"));
      const waiter = deferred<void>();
      connectedWaiters.add(waiter);
      return waiter.promise;
    },
    waitUntilDatabaseReady: () => repository.waitUntilConnected(),
  };
}

async function runConsumerLifecycle(input: {
  readonly abortController: AbortController;
  readonly onActiveConsumer: (
    consumer: SupervisedRabbitMqExecutionReadyConsumer | undefined,
  ) => void;
  readonly options: ExecutionWorkerOptions;
  readonly processor: ExecutionReadyProcessor;
  readonly repository: SupervisedPostgresMessagingRepository;
  readonly updateRabbitMqState: (state: RabbitMqConnectionState) => void;
}): Promise<void> {
  const signal = input.abortController.signal;
  while (!signal.aborted) {
    if (!(await waitOrAbort(input.repository.waitUntilConnected(), signal))) break;
    const consumer = SupervisedRabbitMqExecutionReadyConsumer.start(
      input.options.rabbitMqUrl,
      input.processor,
      {
        ...(input.options.rabbitMqHeartbeatSeconds === undefined
          ? {}
          : { heartbeatSeconds: input.options.rabbitMqHeartbeatSeconds }),
        ...(input.options.prefetch === undefined ? {} : { prefetch: input.options.prefetch }),
        ...(input.options.rabbitMqReconnectInitialMilliseconds === undefined
          ? {}
          : {
              initialDelayMilliseconds: input.options.rabbitMqReconnectInitialMilliseconds,
            }),
        ...(input.options.rabbitMqReconnectJitterRatio === undefined
          ? {}
          : { jitterRatio: input.options.rabbitMqReconnectJitterRatio }),
        ...(input.options.rabbitMqReconnectMaxMilliseconds === undefined
          ? {}
          : { maxDelayMilliseconds: input.options.rabbitMqReconnectMaxMilliseconds }),
        onConnectionState: input.updateRabbitMqState,
        topology: runtimeQueueTopology(input.options.queuePrefix ?? "iterminal"),
      },
    );
    input.onActiveConsumer(consumer);
    await waitOrAbort(input.repository.waitUntilDisconnected(), signal);
    await consumer.close();
    input.onActiveConsumer(undefined);
    if (!signal.aborted) {
      input.updateRabbitMqState({
        attempt: 0,
        error: "RabbitMQ consumption paused while PostgreSQL is unavailable",
        state: "DISCONNECTED",
      });
    }
  }
}

async function closeWorker(
  lifecycle: Promise<void>,
  activeConsumer: SupervisedRabbitMqExecutionReadyConsumer | undefined,
  repository: SupervisedPostgresMessagingRepository,
): Promise<void> {
  const results = await Promise.allSettled([
    activeConsumer?.close() ?? Promise.resolve(),
    lifecycle,
  ]);
  const repositoryResult = await Promise.allSettled([repository.close()]);
  const errors: unknown[] = [];
  for (const result of [...results, ...repositoryResult]) {
    if (result.status === "rejected") errors.push(result.reason as unknown);
  }
  if (errors.length > 0) throw new AggregateError(errors, "Execution Worker did not close cleanly");
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  void promise.catch(() => undefined);
  return { promise, reject, resolve };
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
