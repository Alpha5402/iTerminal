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

export const DEFAULT_RABBITMQ_HEARTBEAT_SECONDS = 5;

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
    options: RabbitMqConnectionOptions = {},
  ): Promise<RabbitMqPublisher> {
    const connection = await amqp.connect(withHeartbeat(url, options.heartbeatSeconds), {
      timeout: 5_000,
    });
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
  readonly heartbeatSeconds?: number;
  readonly prefetch?: number;
  readonly retryPublishFailureBackoffMilliseconds?: number;
  readonly topology?: RabbitMqTopology;
}

export interface RabbitMqConnectionState {
  readonly attempt: number;
  readonly error?: string;
  readonly retryInMilliseconds?: number;
  readonly state: "CONNECTING" | "CONNECTED" | "DISCONNECTED";
}

export interface RabbitMqReconnectOptions {
  readonly heartbeatSeconds?: number;
  readonly initialDelayMilliseconds?: number;
  readonly jitterRatio?: number;
  readonly maxDelayMilliseconds?: number;
  readonly now?: () => number;
  readonly onConnectionState?: (state: RabbitMqConnectionState) => void;
  readonly random?: () => number;
}

export interface SupervisedRabbitMqConsumerOptions
  extends RabbitMqConsumerOptions, RabbitMqReconnectOptions {}

export class RabbitMqExecutionReadyConsumer {
  readonly #closed: Promise<Error | undefined>;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #topology: RabbitMqTopology;
  readonly #retryPublishFailureBackoffMilliseconds: number;
  #closePromise: Promise<void> | undefined;
  #consumerTag: string | undefined;
  #resolveClosed!: (error: Error | undefined) => void;
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
    this.#closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    let connectionError: Error | undefined;
    const rememberError = (error: unknown): void => {
      connectionError = asError(error);
    };
    const reportClosed = (): void => this.#resolveClosed(connectionError);
    this.connection.on("error", rememberError);
    this.channel.on("error", rememberError);
    this.retryChannel.on("error", rememberError);
    this.connection.once("close", reportClosed);
    this.channel.once("close", reportClosed);
    this.retryChannel.once("close", reportClosed);
  }

  public static async connect(
    url: string,
    processor: ExecutionReadyProcessor,
    options: RabbitMqConsumerOptions = {},
  ): Promise<RabbitMqExecutionReadyConsumer> {
    const topology = options.topology ?? runtimeQueueTopology();
    const connection = await amqp.connect(withHeartbeat(url, options.heartbeatSeconds), {
      timeout: 5_000,
    });
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

  public close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#consumerTag !== undefined) {
      await this.channel.cancel(this.#consumerTag).catch(() => undefined);
      this.#consumerTag = undefined;
    }
    await Promise.allSettled([...this.#inFlight]);
    await this.retryChannel.close().catch(() => undefined);
    await this.channel.close().catch(() => undefined);
    await this.connection.close().catch(() => undefined);
    this.#resolveClosed(undefined);
  }

  public waitUntilClosed(): Promise<Error | undefined> {
    return this.#closed;
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

export class SupervisedRabbitMqPublisher implements DurableMessagePublisher {
  readonly #reconnect: NormalizedReconnectOptions;
  #attempt = 0;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #lastError: Error | undefined;
  #nextConnectAt = 0;
  #publisher: RabbitMqPublisher | undefined;
  #tail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly url: string,
    private readonly topology: RabbitMqTopology = runtimeQueueTopology(),
    options: RabbitMqReconnectOptions = {},
  ) {
    this.#reconnect = normalizeReconnectOptions(options);
  }

  public async publish(message: ClaimedOutboxMessage): Promise<void> {
    const operation = this.#tail.then(() => this.#publish(message));
    this.#tail = operation.catch(() => undefined);
    await operation;
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    const publisher = this.#publisher;
    this.#publisher = undefined;
    await publisher?.close();
  }

  async #publish(message: ClaimedOutboxMessage): Promise<void> {
    if (this.#closed) throw new Error("RabbitMQ publisher is closed");
    const publisher = await this.#getPublisher();
    try {
      await publisher.publish(message);
      this.#attempt = 0;
      this.#lastError = undefined;
      this.#nextConnectAt = 0;
    } catch (error) {
      await this.#invalidate(publisher, error);
      throw error;
    }
  }

  async #getPublisher(): Promise<RabbitMqPublisher> {
    if (this.#publisher !== undefined) return this.#publisher;
    const remaining = this.#nextConnectAt - this.#reconnect.now();
    if (remaining > 0) {
      throw new Error(
        `RabbitMQ reconnect is cooling down for ${remaining.toString()}ms: ${
          this.#lastError?.message ?? "connection unavailable"
        }`,
      );
    }
    const attempt = this.#attempt + 1;
    notifyConnectionState(this.#reconnect, { attempt, state: "CONNECTING" });
    try {
      const publisher = await RabbitMqPublisher.connect(this.url, this.topology, {
        ...(this.#reconnect.heartbeatSeconds === undefined
          ? {}
          : { heartbeatSeconds: this.#reconnect.heartbeatSeconds }),
      });
      if (this.#closed) {
        await publisher.close();
        throw new Error("RabbitMQ publisher is closed");
      }
      this.#publisher = publisher;
      notifyConnectionState(this.#reconnect, { attempt, state: "CONNECTED" });
      return publisher;
    } catch (error) {
      this.#recordFailure(error, attempt);
      throw error;
    }
  }

  async #invalidate(publisher: RabbitMqPublisher, error: unknown): Promise<void> {
    if (this.#publisher === publisher) this.#publisher = undefined;
    this.#recordFailure(error, this.#attempt + 1);
    await publisher.close().catch(() => undefined);
  }

  #recordFailure(error: unknown, attempt: number): void {
    const failure = asError(error);
    this.#attempt = attempt;
    this.#lastError = failure;
    const retryInMilliseconds = reconnectDelay(attempt, this.#reconnect);
    this.#nextConnectAt = this.#reconnect.now() + retryInMilliseconds;
    notifyConnectionState(this.#reconnect, {
      attempt,
      error: failure.message,
      retryInMilliseconds,
      state: "DISCONNECTED",
    });
  }
}

export class SupervisedRabbitMqExecutionReadyConsumer {
  readonly #abortController = new AbortController();
  readonly #reconnect: NormalizedReconnectOptions;
  readonly #runPromise: Promise<void>;
  #active: RabbitMqExecutionReadyConsumer | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  private constructor(
    private readonly url: string,
    private readonly processor: ExecutionReadyProcessor,
    private readonly options: SupervisedRabbitMqConsumerOptions,
  ) {
    this.#reconnect = normalizeReconnectOptions(options);
    this.#runPromise = this.#run();
  }

  public static start(
    url: string,
    processor: ExecutionReadyProcessor,
    options: SupervisedRabbitMqConsumerOptions = {},
  ): SupervisedRabbitMqExecutionReadyConsumer {
    return new SupervisedRabbitMqExecutionReadyConsumer(url, processor, options);
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abortController.abort();
    await this.#active?.close().catch(() => undefined);
    await this.#runPromise;
  }

  async #run(): Promise<void> {
    let attempt = 0;
    while (!this.#abortController.signal.aborted) {
      attempt += 1;
      notifyConnectionState(this.#reconnect, { attempt, state: "CONNECTING" });
      try {
        const consumer = await RabbitMqExecutionReadyConsumer.connect(this.url, this.processor, {
          ...(this.#reconnect.heartbeatSeconds === undefined
            ? {}
            : { heartbeatSeconds: this.#reconnect.heartbeatSeconds }),
          ...(this.options.prefetch === undefined ? {} : { prefetch: this.options.prefetch }),
          ...(this.options.retryPublishFailureBackoffMilliseconds === undefined
            ? {}
            : {
                retryPublishFailureBackoffMilliseconds:
                  this.options.retryPublishFailureBackoffMilliseconds,
              }),
          ...(this.options.topology === undefined ? {} : { topology: this.options.topology }),
        });
        if (this.#abortController.signal.aborted) {
          await consumer.close();
          break;
        }
        this.#active = consumer;
        notifyConnectionState(this.#reconnect, { attempt, state: "CONNECTED" });
        attempt = 0;
        const closeError = await consumer.waitUntilClosed();
        this.#active = undefined;
        await consumer.close().catch(() => undefined);
        if (this.#abortController.signal.aborted) break;
        const retryInMilliseconds = reconnectDelay(1, this.#reconnect);
        notifyConnectionState(this.#reconnect, {
          attempt: 1,
          error: closeError?.message ?? "RabbitMQ consumer connection closed",
          retryInMilliseconds,
          state: "DISCONNECTED",
        });
        await abortableDelay(retryInMilliseconds, this.#abortController.signal);
      } catch (error) {
        if (this.#abortController.signal.aborted) break;
        const retryInMilliseconds = reconnectDelay(attempt, this.#reconnect);
        notifyConnectionState(this.#reconnect, {
          attempt,
          error: asError(error).message,
          retryInMilliseconds,
          state: "DISCONNECTED",
        });
        await abortableDelay(retryInMilliseconds, this.#abortController.signal);
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

interface NormalizedReconnectOptions {
  readonly heartbeatSeconds?: number;
  readonly initialDelayMilliseconds: number;
  readonly jitterRatio: number;
  readonly maxDelayMilliseconds: number;
  readonly now: () => number;
  readonly onConnectionState?: (state: RabbitMqConnectionState) => void;
  readonly random: () => number;
}

function normalizeReconnectOptions(options: RabbitMqReconnectOptions): NormalizedReconnectOptions {
  const initialDelayMilliseconds = options.initialDelayMilliseconds ?? 250;
  const maxDelayMilliseconds =
    options.maxDelayMilliseconds ?? Math.max(30_000, initialDelayMilliseconds);
  const jitterRatio = options.jitterRatio ?? 0.2;
  if (!Number.isSafeInteger(initialDelayMilliseconds) || initialDelayMilliseconds < 1) {
    throw new Error("RabbitMQ reconnect initial delay must be a positive integer");
  }
  if (
    !Number.isSafeInteger(maxDelayMilliseconds) ||
    maxDelayMilliseconds < initialDelayMilliseconds
  ) {
    throw new Error(
      "RabbitMQ reconnect maximum delay must be an integer not below the initial delay",
    );
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error("RabbitMQ reconnect jitter ratio must be between zero and one");
  }
  if (
    options.heartbeatSeconds !== undefined &&
    (!Number.isSafeInteger(options.heartbeatSeconds) || options.heartbeatSeconds < 1)
  ) {
    throw new Error("RabbitMQ heartbeat must be a positive integer in seconds");
  }
  return {
    ...(options.heartbeatSeconds === undefined
      ? {}
      : { heartbeatSeconds: options.heartbeatSeconds }),
    initialDelayMilliseconds,
    jitterRatio,
    maxDelayMilliseconds,
    now: options.now ?? Date.now,
    ...(options.onConnectionState === undefined
      ? {}
      : { onConnectionState: options.onConnectionState }),
    random: options.random ?? Math.random,
  };
}

interface RabbitMqConnectionOptions {
  readonly heartbeatSeconds?: number;
}

function withHeartbeat(url: string, heartbeatSeconds?: number): string {
  if (
    heartbeatSeconds !== undefined &&
    (!Number.isSafeInteger(heartbeatSeconds) || heartbeatSeconds < 1)
  ) {
    throw new Error("RabbitMQ heartbeat must be a positive integer in seconds");
  }
  const parsed = new URL(url);
  if (heartbeatSeconds !== undefined || !parsed.searchParams.has("heartbeat")) {
    parsed.searchParams.set(
      "heartbeat",
      (heartbeatSeconds ?? DEFAULT_RABBITMQ_HEARTBEAT_SECONDS).toString(),
    );
  }
  return parsed.toString();
}

function reconnectDelay(attempt: number, options: NormalizedReconnectOptions): number {
  const exponential = Math.min(
    options.maxDelayMilliseconds,
    options.initialDelayMilliseconds * 2 ** Math.max(0, Math.min(attempt - 1, 20)),
  );
  const jitter = exponential * options.jitterRatio * (options.random() * 2 - 1);
  return Math.max(1, Math.round(exponential + jitter));
}

function notifyConnectionState(
  options: NormalizedReconnectOptions,
  state: RabbitMqConnectionState,
): void {
  try {
    options.onConnectionState?.(state);
  } catch {
    // Diagnostics must not change transport behavior.
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
