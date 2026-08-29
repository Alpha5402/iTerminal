import { createHash } from "node:crypto";

export interface ClaimedOutboxMessage {
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly attempt: number;
  readonly claimToken: string;
  readonly createdAt: string;
  readonly eventType: string;
  readonly id: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OutboxRepository {
  claimBatch(input: {
    readonly leaseMilliseconds: number;
    readonly limit: number;
    readonly now: Date;
    readonly publisherId: string;
  }): Promise<readonly ClaimedOutboxMessage[]>;
  markPublished(input: {
    readonly claimToken: string;
    readonly id: string;
    readonly publishedAt: Date;
    readonly publisherId: string;
  }): Promise<void>;
  releaseFailed(input: {
    readonly claimToken: string;
    readonly error: string;
    readonly id: string;
    readonly nextAttemptAt: Date;
    readonly publisherId: string;
  }): Promise<void>;
}

export interface DurableMessagePublisher {
  publish(message: ClaimedOutboxMessage): Promise<void>;
}

export interface OutboxRelayOptions {
  readonly batchSize?: number;
  readonly leaseMilliseconds?: number;
  readonly now?: () => Date;
  readonly pollMilliseconds?: number;
  readonly retryDelay?: (attempt: number) => number;
}

export interface OutboxRelayReport {
  readonly claimed: number;
  readonly failed: number;
  readonly published: number;
}

export class OutboxRelay {
  readonly #batchSize: number;
  readonly #leaseMilliseconds: number;
  readonly #now: () => Date;
  readonly #pollMilliseconds: number;
  readonly #retryDelay: (attempt: number) => number;

  public constructor(
    private readonly publisherId: string,
    private readonly repository: OutboxRepository,
    private readonly publisher: DurableMessagePublisher,
    options: OutboxRelayOptions = {},
  ) {
    this.#batchSize = options.batchSize ?? 50;
    this.#leaseMilliseconds = options.leaseMilliseconds ?? 30_000;
    this.#now = options.now ?? (() => new Date());
    this.#pollMilliseconds = options.pollMilliseconds ?? 250;
    this.#retryDelay = options.retryDelay ?? exponentialRetryDelay;
  }

  public async publishBatch(): Promise<OutboxRelayReport> {
    const claimed = await this.repository.claimBatch({
      leaseMilliseconds: this.#leaseMilliseconds,
      limit: this.#batchSize,
      now: this.#now(),
      publisherId: this.publisherId,
    });
    let failed = 0;
    let published = 0;
    for (const message of claimed) {
      try {
        await this.publisher.publish(message);
        await this.repository.markPublished({
          claimToken: message.claimToken,
          id: message.id,
          publishedAt: this.#now(),
          publisherId: this.publisherId,
        });
        published += 1;
      } catch (error) {
        failed += 1;
        await this.repository.releaseFailed({
          claimToken: message.claimToken,
          error: errorMessage(error),
          id: message.id,
          nextAttemptAt: new Date(this.#now().getTime() + this.#retryDelay(message.attempt)),
          publisherId: this.publisherId,
        });
      }
    }
    return { claimed: claimed.length, failed, published };
  }

  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const report = await this.publishBatch();
      if (report.claimed === 0) await abortableDelay(this.#pollMilliseconds, signal);
    }
  }
}

export interface ExecutionReadyMessage {
  readonly aggregate: Readonly<{
    readonly sessionId: string;
  }>;
  readonly id: string;
  readonly occurredAt: string;
  readonly payload: Readonly<{
    readonly executionId: string;
    readonly generation: number;
  }>;
  readonly schemaVersion: 1;
  readonly type: "ExecutionReady";
}

export type InboxAcquireResult =
  | Readonly<{ kind: "ACQUIRED"; attempt: number; leaseToken: string }>
  | Readonly<{ kind: "BUSY" }>
  | Readonly<{ kind: "COMPLETED" }>
  | Readonly<{ kind: "CONFLICT" }>;

export interface ConsumerInbox {
  acquire(input: {
    readonly consumerId: string;
    readonly leaseMilliseconds: number;
    readonly messageId: string;
    readonly now: Date;
    readonly payloadHash: string;
  }): Promise<InboxAcquireResult>;
  complete(input: {
    readonly consumerId: string;
    readonly leaseToken: string;
    readonly messageId: string;
    readonly outcome: string;
    readonly completedAt: Date;
  }): Promise<void>;
  release(input: {
    readonly consumerId: string;
    readonly error: string;
    readonly leaseToken: string;
    readonly messageId: string;
  }): Promise<void>;
}

export type ExecutionReadyInspection =
  | Readonly<{
      kind: "READY";
      ownerId: string;
    }>
  | Readonly<{
      kind: "STALE";
      reason: string;
    }>
  | Readonly<{
      kind: "INVALID";
      reason: string;
    }>;

export interface ExecutionReadyInspector {
  inspectExecutionReady(message: ExecutionReadyMessage): Promise<ExecutionReadyInspection>;
}

export type ConsumerDisposition =
  | Readonly<{ kind: "ACK"; outcome: "DELIVERED" | "DUPLICATE" | "IGNORED_STALE" }>
  | Readonly<{ kind: "RETRY"; reason: string }>
  | Readonly<{ kind: "DEAD_LETTER"; reason: string }>;

export interface ExecutionReadyProcessorOptions {
  readonly inboxLeaseMilliseconds?: number;
  readonly maxAttempts?: number;
  readonly now?: () => Date;
}

export class ExecutionReadyProcessor {
  readonly #inboxLeaseMilliseconds: number;
  readonly #maxAttempts: number;
  readonly #now: () => Date;

  public constructor(
    private readonly consumerId: string,
    private readonly inbox: ConsumerInbox,
    private readonly inspector: ExecutionReadyInspector,
    private readonly onReady: (
      message: ExecutionReadyMessage,
      inspection: Extract<ExecutionReadyInspection, { kind: "READY" }>,
    ) => Promise<void>,
    options: ExecutionReadyProcessorOptions = {},
  ) {
    this.#inboxLeaseMilliseconds = options.inboxLeaseMilliseconds ?? 30_000;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#now = options.now ?? (() => new Date());
  }

  public async process(message: ExecutionReadyMessage): Promise<ConsumerDisposition> {
    const acquired = await this.inbox.acquire({
      consumerId: this.consumerId,
      leaseMilliseconds: this.#inboxLeaseMilliseconds,
      messageId: message.id,
      now: this.#now(),
      payloadHash: messageHash(message),
    });
    if (acquired.kind === "COMPLETED") return { kind: "ACK", outcome: "DUPLICATE" };
    if (acquired.kind === "BUSY") {
      return { kind: "RETRY", reason: "Message is already being processed" };
    }
    if (acquired.kind === "CONFLICT") {
      return { kind: "DEAD_LETTER", reason: "Message ID was reused with different content" };
    }

    try {
      const inspection = await this.inspector.inspectExecutionReady(message);
      if (inspection.kind === "INVALID") {
        await this.inbox.complete({
          completedAt: this.#now(),
          consumerId: this.consumerId,
          leaseToken: acquired.leaseToken,
          messageId: message.id,
          outcome: "INVALID",
        });
        return { kind: "DEAD_LETTER", reason: inspection.reason };
      }
      if (inspection.kind === "STALE") {
        await this.inbox.complete({
          completedAt: this.#now(),
          consumerId: this.consumerId,
          leaseToken: acquired.leaseToken,
          messageId: message.id,
          outcome: "IGNORED_STALE",
        });
        return { kind: "ACK", outcome: "IGNORED_STALE" };
      }
      await this.onReady(message, inspection);
      await this.inbox.complete({
        completedAt: this.#now(),
        consumerId: this.consumerId,
        leaseToken: acquired.leaseToken,
        messageId: message.id,
        outcome: "DELIVERED",
      });
      return { kind: "ACK", outcome: "DELIVERED" };
    } catch (error) {
      if (error instanceof PermanentDeliveryError || acquired.attempt >= this.#maxAttempts) {
        await this.inbox.complete({
          completedAt: this.#now(),
          consumerId: this.consumerId,
          leaseToken: acquired.leaseToken,
          messageId: message.id,
          outcome: "FAILED_PERMANENT",
        });
        return { kind: "DEAD_LETTER", reason: errorMessage(error) };
      }
      await this.inbox.release({
        consumerId: this.consumerId,
        error: errorMessage(error),
        leaseToken: acquired.leaseToken,
        messageId: message.id,
      });
      return { kind: "RETRY", reason: errorMessage(error) };
    }
  }
}

export class PermanentDeliveryError extends Error {}

export function executionReadyFromOutbox(message: ClaimedOutboxMessage): ExecutionReadyMessage {
  if (message.eventType !== "ExecutionReady" || message.aggregateType !== "session") {
    throw new PermanentDeliveryError(`Unsupported Outbox event: ${message.eventType}`);
  }
  const executionId = message.payload.executionId;
  const generation = message.payload.generation;
  if (
    typeof executionId !== "string" ||
    executionId.length === 0 ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation <= 0
  ) {
    throw new PermanentDeliveryError("ExecutionReady Outbox payload is invalid");
  }
  return {
    aggregate: { sessionId: message.aggregateId },
    id: message.id,
    occurredAt: message.createdAt,
    payload: { executionId, generation },
    schemaVersion: 1,
    type: "ExecutionReady",
  };
}

export function parseExecutionReadyMessage(value: Buffer | string): ExecutionReadyMessage {
  let candidate: unknown;
  try {
    candidate = JSON.parse(typeof value === "string" ? value : value.toString("utf8"));
  } catch {
    throw new PermanentDeliveryError("RabbitMQ message is not valid JSON");
  }
  if (!isRecord(candidate)) throw new PermanentDeliveryError("Message must be an object");
  const aggregate = candidate.aggregate;
  const payload = candidate.payload;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.type !== "ExecutionReady" ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    typeof candidate.occurredAt !== "string" ||
    !isRecord(aggregate) ||
    typeof aggregate.sessionId !== "string" ||
    aggregate.sessionId.length === 0 ||
    !isRecord(payload) ||
    typeof payload.executionId !== "string" ||
    payload.executionId.length === 0 ||
    typeof payload.generation !== "number" ||
    !Number.isSafeInteger(payload.generation) ||
    payload.generation <= 0
  ) {
    throw new PermanentDeliveryError("ExecutionReady message schema is invalid");
  }
  return {
    aggregate: { sessionId: aggregate.sessionId },
    id: candidate.id,
    occurredAt: candidate.occurredAt,
    payload: { executionId: payload.executionId, generation: payload.generation },
    schemaVersion: 1,
    type: "ExecutionReady",
  };
}

export function serializeExecutionReadyMessage(message: ExecutionReadyMessage): Buffer {
  return Buffer.from(JSON.stringify(message), "utf8");
}

function messageHash(message: ExecutionReadyMessage): string {
  return createHash("sha256").update(canonicalJson(message)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new PermanentDeliveryError("Message is not serializable");
  return serialized;
}

function exponentialRetryDelay(attempt: number): number {
  return Math.min(30_000, 250 * 2 ** Math.max(0, Math.min(attempt - 1, 7)));
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
