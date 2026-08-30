import { ExecutionReadyProcessor, type ExecutionReadyMessage } from "@iterminal/messaging";
import { PostgresMessagingRepository } from "@iterminal/persistence-postgres";
import { RabbitMqExecutionReadyConsumer, runtimeQueueTopology } from "@iterminal/queue-rabbitmq";
import { runtimeOwnerIdForSocket, UnixRuntimeClient } from "@iterminal/runtime-rpc";

export interface ExecutionWorkerHandle {
  close(): Promise<void>;
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
  let consumer: RabbitMqExecutionReadyConsumer | undefined;
  try {
    consumer = await RabbitMqExecutionReadyConsumer.connect(options.rabbitMqUrl, processor, {
      ...(options.prefetch === undefined ? {} : { prefetch: options.prefetch }),
      topology: runtimeQueueTopology(options.queuePrefix ?? "iterminal"),
    });
  } catch (error) {
    await repository.close().catch(() => undefined);
    throw error;
  }
  const activeConsumer = consumer;
  let closePromise: Promise<void> | undefined;
  return {
    close: () => {
      closePromise ??= Promise.all([activeConsumer.close(), repository.close()]).then(
        () => undefined,
      );
      return closePromise;
    },
  };
}
