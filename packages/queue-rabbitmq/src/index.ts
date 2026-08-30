import { once } from "node:events";

import {
  executionReadyFromOutbox,
  parseExecutionReadyMessage,
  serializeExecutionReadyMessage,
  type ClaimedOutboxMessage,
  type ConsumerDisposition,
  type DurableMessagePublisher,
  type ExecutionReadyMessage,
  type ExecutionReadyProcessor,
} from "@iterminal/messaging";
import amqp, {
  type Channel,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
  type Options,
} from "amqplib";

export interface RabbitMqTopology {
  readonly deadLetterExchange: string;
  readonly deadLetterQueue: string;
  readonly exchange: string;
  readonly queue: string;
  readonly retryExchange: string;
  readonly retryMilliseconds: number;
  readonly retryQueue: string;
  readonly routingKey: string;
}

export function runtimeQueueTopology(prefix = "iterminal"): RabbitMqTopology {
  return {
    deadLetterExchange: `${prefix}.runtime.dlx`,
    deadLetterQueue: `${prefix}.execution-ready.dlq`,
    exchange: `${prefix}.runtime`,
    queue: `${prefix}.execution-ready`,
    retryExchange: `${prefix}.runtime.retry`,
    retryMilliseconds: 250,
    retryQueue: `${prefix}.execution-ready.retry`,
    routingKey: "execution.ready",
  };
}

export async function assertRuntimeQueueTopology(
  channel: Channel,
  topology: RabbitMqTopology,
): Promise<void> {
  await channel.assertExchange(topology.exchange, "direct", { durable: true });
  await channel.assertExchange(topology.retryExchange, "direct", { durable: true });
  await channel.assertExchange(topology.deadLetterExchange, "direct", { durable: true });
  await channel.assertQueue(topology.queue, {
    arguments: {
      "x-dead-letter-exchange": topology.deadLetterExchange,
      "x-dead-letter-routing-key": topology.routingKey,
      "x-queue-type": "quorum",
    },
    durable: true,
  });
  await channel.assertQueue(topology.retryQueue, {
    arguments: {
      "x-dead-letter-exchange": topology.exchange,
      "x-dead-letter-routing-key": topology.routingKey,
      "x-message-ttl": topology.retryMilliseconds,
      "x-queue-type": "quorum",
    },
    durable: true,
  });
  await channel.assertQueue(topology.deadLetterQueue, {
    arguments: { "x-queue-type": "quorum" },
    durable: true,
  });
  await channel.bindQueue(topology.queue, topology.exchange, topology.routingKey);
  await channel.bindQueue(topology.retryQueue, topology.retryExchange, topology.routingKey);
  await channel.bindQueue(
    topology.deadLetterQueue,
    topology.deadLetterExchange,
    topology.routingKey,
  );
}

export class RabbitMqPublisher implements DurableMessagePublisher {
  #tail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly connection: ChannelModel,
    private readonly channel: ConfirmChannel,
    private readonly topology: RabbitMqTopology,
  ) {}

  public static async connect(
    url: string,
    topology: RabbitMqTopology = runtimeQueueTopology(),
  ): Promise<RabbitMqPublisher> {
    const connection = await amqp.connect(url, { timeout: 5_000 });
    const channel = await connection.createConfirmChannel();
    attachErrorSinks(connection, channel);
    await assertRuntimeQueueTopology(channel, topology);
    return new RabbitMqPublisher(connection, channel, topology);
  }

  public async publish(message: ClaimedOutboxMessage): Promise<void> {
    const wire = executionReadyFromOutbox(message);
    const operation = this.#tail.then(() =>
      publishConfirmed(
        this.channel,
        this.topology.exchange,
        this.topology.routingKey,
        serializeExecutionReadyMessage(wire),
        messageOptions(wire),
      ),
    );
    this.#tail = operation.catch(() => undefined);
    await operation;
  }

  public async close(): Promise<void> {
    await this.#tail;
    await this.channel.close().catch(() => undefined);
    await this.connection.close().catch(() => undefined);
  }
}

export interface RabbitMqConsumerOptions {
  readonly prefetch?: number;
  readonly retryPublishFailureBackoffMilliseconds?: number;
  readonly topology?: RabbitMqTopology;
}

export class RabbitMqExecutionReadyConsumer {
  readonly #inFlight = new Set<Promise<void>>();
  readonly #topology: RabbitMqTopology;
  readonly #retryPublishFailureBackoffMilliseconds: number;
  #consumerTag: string | undefined;
  #retryTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly connection: ChannelModel,
    private readonly channel: Channel,
    private readonly retryChannel: ConfirmChannel,
    private readonly processor: ExecutionReadyProcessor,
    topology: RabbitMqTopology,
    retryPublishFailureBackoffMilliseconds: number,
  ) {
    this.#topology = topology;
    this.#retryPublishFailureBackoffMilliseconds = retryPublishFailureBackoffMilliseconds;
  }

  public static async connect(
    url: string,
    processor: ExecutionReadyProcessor,
    options: RabbitMqConsumerOptions = {},
  ): Promise<RabbitMqExecutionReadyConsumer> {
    const topology = options.topology ?? runtimeQueueTopology();
    const connection = await amqp.connect(url, { timeout: 5_000 });
    const channel = await connection.createChannel();
    const retryChannel = await connection.createConfirmChannel();
    attachErrorSinks(connection, channel, retryChannel);
    await assertRuntimeQueueTopology(channel, topology);
    await channel.prefetch(options.prefetch ?? 8);
    const consumer = new RabbitMqExecutionReadyConsumer(
      connection,
      channel,
      retryChannel,
      processor,
      topology,
      Math.max(1, options.retryPublishFailureBackoffMilliseconds ?? topology.retryMilliseconds),
    );
    await consumer.#start();
    return consumer;
  }

  public async close(): Promise<void> {
    if (this.#consumerTag !== undefined) {
      await this.channel.cancel(this.#consumerTag).catch(() => undefined);
      this.#consumerTag = undefined;
    }
    await Promise.allSettled([...this.#inFlight]);
    await this.retryChannel.close().catch(() => undefined);
    await this.channel.close().catch(() => undefined);
    await this.connection.close().catch(() => undefined);
  }

  async #start(): Promise<void> {
    const reply = await this.channel.consume(
      this.#topology.queue,
      (message) => {
        if (message === null) return;
        const task = this.#handle(message);
        this.#inFlight.add(task);
        void task.finally(() => this.#inFlight.delete(task));
      },
      { noAck: false },
    );
    this.#consumerTag = reply.consumerTag;
  }

  async #handle(delivery: ConsumeMessage): Promise<void> {
    let message: ExecutionReadyMessage;
    try {
      message = parseExecutionReadyMessage(delivery.content);
    } catch {
      this.channel.reject(delivery, false);
      return;
    }

    let disposition: ConsumerDisposition;
    try {
      disposition = await this.processor.process(message);
    } catch {
      this.channel.nack(delivery, false, true);
      return;
    }
    if (disposition.kind === "ACK") {
      this.channel.ack(delivery);
      return;
    }
    if (disposition.kind === "DEAD_LETTER") {
      this.channel.reject(delivery, false);
      return;
    }
    try {
      const retry = this.#retryTail.then(() =>
        publishConfirmed(
          this.retryChannel,
          this.#topology.retryExchange,
          this.#topology.routingKey,
          delivery.content,
          {
            ...delivery.properties,
            persistent: true,
            timestamp: Math.floor(Date.now() / 1000),
          },
        ),
      );
      this.#retryTail = retry.catch(() => undefined);
      await retry;
      this.channel.ack(delivery);
    } catch {
      await delay(this.#retryPublishFailureBackoffMilliseconds);
      try {
        this.channel.nack(delivery, false, true);
      } catch {
        // Closing the consumer already returns unacked deliveries to RabbitMQ.
      }
    }
  }
}

export async function publishConfirmed(
  channel: ConfirmChannel,
  exchange: string,
  routingKey: string,
  content: Buffer,
  options: Options.Publish,
): Promise<void> {
  let returned: Error | undefined;
  const onReturn = (message: { fields: { replyText: string } }): void => {
    returned = new Error(`RabbitMQ returned message: ${message.fields.replyText}`);
  };
  channel.once("return", onReturn);
  try {
    let drain: Promise<unknown> | undefined;
    const confirmed = new Promise<void>((resolve, reject) => {
      const writable = channel.publish(
        exchange,
        routingKey,
        content,
        { ...options, mandatory: true, persistent: true },
        (error) =>
          error === null || error === undefined
            ? resolve()
            : reject(error instanceof Error ? error : new Error(String(error))),
      );
      if (!writable) drain = once(channel, "drain");
    });
    await Promise.all([confirmed, drain]);
    if (returned !== undefined) throw returned;
  } finally {
    channel.off("return", onReturn);
  }
}

function messageOptions(message: ExecutionReadyMessage): Options.Publish {
  return {
    contentType: "application/json",
    contentEncoding: "utf-8",
    messageId: message.id,
    timestamp: Math.floor(new Date(message.occurredAt).getTime() / 1000),
    type: message.type,
  };
}

function attachErrorSinks(...emitters: Array<Channel | ChannelModel>): void {
  for (const emitter of emitters) {
    emitter.on("error", () => undefined);
    emitter.on("handler-error", () => undefined);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
