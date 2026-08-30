import { ExecutionReadyProcessor, type ExecutionReadyMessage } from "@iterminal/messaging";
import { PostgresMessagingRepository } from "@iterminal/persistence-postgres";
import {
  runtimeQueueTopology,
  SupervisedRabbitMqExecutionReadyConsumer,
  type RabbitMqConnectionState,
} from "@iterminal/queue-rabbitmq";
import { runtimeOwnerIdForSocket, UnixRuntimeClient } from "@iterminal/runtime-rpc";

export interface ExecutionWorkerHandle {
  connectionState(): RabbitMqConnectionState;
  close(): Promise<void>;
  waitUntilConnected(): Promise<void>;
}

export interface ExecutionWorkerOptions {
  readonly beforeDispatch?: (message: ExecutionReadyMessage) => void;
  readonly consumerId?: string;
  readonly databaseUrl: string;
  readonly inboxLeaseMilliseconds?: number;
  readonly maxAttempts?: number;
  readonly ownerId?: string;
  readonly prefetch?: number;
  readonly queuePrefix?: string;
  readonly rabbitMqUrl: string;
  readonly rabbitMqReconnectInitialMilliseconds?: number;
  readonly rabbitMqReconnectMaxMilliseconds?: number;
  readonly onRabbitMqConnectionState?: (state: RabbitMqConnectionState) => void;
  readonly runtimeSocketPath: string;
}

export async function startExecutionWorker(
  options: ExecutionWorkerOptions,
): Promise<ExecutionWorkerHandle> {
  const ownerId = options.ownerId ?? runtimeOwnerIdForSocket(options.runtimeSocketPath);
  const consumerId = options.consumerId ?? `execution-worker:${ownerId}`;
  const repository = new PostgresMessagingRepository(options.databaseUrl);
  await repository.migrate();
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
  let resolveFirstConnection!: () => void;
  let rejectFirstConnection!: (reason?: unknown) => void;
  const firstConnection = new Promise<void>((resolve, reject) => {
    resolveFirstConnection = resolve;
    rejectFirstConnection = reject;
  });
  void firstConnection.catch(() => undefined);
  const consumer = SupervisedRabbitMqExecutionReadyConsumer.start(options.rabbitMqUrl, processor, {
    ...(options.prefetch === undefined ? {} : { prefetch: options.prefetch }),
    ...(options.rabbitMqReconnectInitialMilliseconds === undefined
      ? {}
      : {
          initialDelayMilliseconds: options.rabbitMqReconnectInitialMilliseconds,
        }),
    ...(options.rabbitMqReconnectMaxMilliseconds === undefined
      ? {}
      : { maxDelayMilliseconds: options.rabbitMqReconnectMaxMilliseconds }),
    onConnectionState: (state) => {
      connectionState = state;
      if (state.state === "CONNECTED") resolveFirstConnection();
      options.onRabbitMqConnectionState?.(state);
    },
    topology: runtimeQueueTopology(options.queuePrefix ?? "iterminal"),
  });
  let closePromise: Promise<void> | undefined;
  return {
    connectionState: () => connectionState,
    close: () => {
      rejectFirstConnection(new Error("Execution Worker closed before connecting to RabbitMQ"));
      closePromise ??= Promise.all([consumer.close(), repository.close()]).then(() => undefined);
      return closePromise;
    },
    waitUntilConnected: () => firstConnection,
  };
}
