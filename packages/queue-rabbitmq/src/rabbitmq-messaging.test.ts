import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

import {
  ExecutionReadyProcessor,
  OutboxRelay,
  serializeExecutionReadyMessage,
} from "@iterminal/messaging";
import {
  PostgresMessagingRepository,
  PostgresRuntimeRepository,
  type AcceptExecuteTransaction,
} from "@iterminal/persistence-postgres";
import amqp, { type ChannelModel } from "amqplib";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertRuntimeQueueTopology,
  publishConfirmed,
  RabbitMqExecutionReadyConsumer,
  RabbitMqPublisher,
  runtimeQueueTopology,
  type RabbitMqTopology,
} from "./index.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const rabbitMqUrl = process.env.ITERM_RABBITMQ_URL;
const describeMessaging =
  databaseUrl === undefined || rabbitMqUrl === undefined ? describe.skip : describe;
const repositoryRoot = resolve(import.meta.dirname, "../../..");

describeMessaging("M8.1 reliable RabbitMQ notification", () => {
  const databaseTarget = databaseUrl ?? "postgresql://localhost/iterminal_test";
  const runtimeRepository = new PostgresRuntimeRepository(databaseTarget);
  const messagingRepository = new PostgresMessagingRepository(databaseTarget);
  const pool = new Pool({ connectionString: databaseUrl });
  const publishers: RabbitMqPublisher[] = [];
  const consumers: RabbitMqExecutionReadyConsumer[] = [];
  const topologies: RabbitMqTopology[] = [];

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M8 tests refuse to mutate any database except iterminal_test");
    }
    await runtimeRepository.migrate();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox, consumer_inbox RESTART IDENTITY CASCADE");
  });

  afterEach(async () => {
    for (const consumer of consumers.splice(0)) await consumer.close();
    for (const publisher of publishers.splice(0)) await publisher.close();
    for (const topology of topologies.splice(0)) await deleteTopology(topology);
  });

  afterAll(async () => {
    await messagingRepository.close();
    await runtimeRepository.close();
    await pool.end();
  });

  it("deduplicates publish-after-confirm crash replay through Consumer Inbox", async () => {
    const accepted = await createAcceptedExecution(runtimeRepository, "duplicate");
    const topology = newTopology("duplicate");
    const publisher = await createPublisher(topology);
    let handlerCalls = 0;
    await createConsumer(topology, () => {
      handlerCalls += 1;
      return Promise.resolve();
    });
    const claimed = await messagingRepository.claimBatch({
      leaseMilliseconds: 100,
      limit: 1,
      now: new Date(),
      publisherId: "publisher-crashed",
    });
    expect(claimed).toHaveLength(1);
    await publisher.publish(required(claimed[0]));
    await waitFor(async () => (await inboxState(accepted.outboxId)).outcome === "DELIVERED");
    await delay(125);

    const recoveredRelay = new OutboxRelay("publisher-recovered", messagingRepository, publisher, {
      retryDelay: () => 0,
    });
    expect(await recoveredRelay.publishBatch()).toEqual({ claimed: 1, failed: 0, published: 1 });
    await waitFor(async () => (await outboxState(accepted.outboxId)).published_at !== null);
    await delay(400);

    expect(handlerCalls).toBe(1);
    expect(await inboxState(accepted.outboxId)).toMatchObject({
      attempts: 1,
      outcome: "DELIVERED",
      status: "COMPLETED",
    });
    expect(await outboxState(accepted.outboxId)).toMatchObject({ attempts: 2, last_error: null });
    const audit = await pool.query<{ count: string }>(
      `SELECT count(*) FROM session_events
        WHERE session_id = $1 AND event_type = 'outbox.published'`,
      [accepted.sessionId],
    );
    expect(audit.rows[0]?.count).toBe("1");

    await publishRaw(
      topology,
      serializeExecutionReadyMessage({
        aggregate: { sessionId: accepted.sessionId },
        id: accepted.outboxId,
        occurredAt: new Date().toISOString(),
        payload: { executionId: accepted.executionId, generation: 2 },
        schemaVersion: 1,
        type: "ExecutionReady",
      }),
      accepted.outboxId,
    );
    await waitFor(async () => (await deadLetterCount(topology)) === 1);
    expect(handlerCalls).toBe(1);
  });

  it("claims one pending Outbox row at most once across concurrent publishers", async () => {
    const messages = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        createAcceptedExecution(runtimeRepository, `claim-${index.toString()}`),
      ),
    );
    const now = new Date();
    const [left, right] = await Promise.all([
      messagingRepository.claimBatch({
        leaseMilliseconds: 30_000,
        limit: 20,
        now,
        publisherId: "publisher-left",
      }),
      messagingRepository.claimBatch({
        leaseMilliseconds: 30_000,
        limit: 20,
        now,
        publisherId: "publisher-right",
      }),
    ]);
    const claimedIds = [...left, ...right].map((message) => message.id);
    expect(claimedIds).toHaveLength(messages.length);
    expect(new Set(claimedIds).size).toBe(messages.length);
  });

  it("retries transient consumer failure through a bounded retry queue", async () => {
    const accepted = await createAcceptedExecution(runtimeRepository, "retry");
    const topology = newTopology("retry");
    const publisher = await createPublisher(topology);
    let handlerCalls = 0;
    await createConsumer(topology, () => {
      handlerCalls += 1;
      if (handlerCalls === 1) {
        return Promise.reject(new Error("temporary owner lookup failure"));
      }
      return Promise.resolve();
    });
    const relay = new OutboxRelay("publisher-retry", messagingRepository, publisher);

    expect(await relay.publishBatch()).toEqual({ claimed: 1, failed: 0, published: 1 });
    await waitFor(async () => (await inboxState(accepted.outboxId)).outcome === "DELIVERED");

    expect(handlerCalls).toBe(2);
    expect(await inboxState(accepted.outboxId)).toMatchObject({
      attempts: 2,
      outcome: "DELIVERED",
      status: "COMPLETED",
    });
  });

  it("nacks and rate-limits requeue when retry publication is unavailable", async () => {
    const accepted = await createAcceptedExecution(runtimeRepository, "retry-outage");
    const topology = newTopology("retry-outage");
    const publisher = await createPublisher(topology);
    let handlerCalls = 0;
    const processor = new ExecutionReadyProcessor(
      "owner-router",
      messagingRepository,
      messagingRepository,
      () => {
        handlerCalls += 1;
        return Promise.reject(new Error("owner temporarily unavailable"));
      },
      { maxAttempts: 100 },
    );
    const consumer = await RabbitMqExecutionReadyConsumer.connect(rabbitMqUrl ?? "", processor, {
      prefetch: 1,
      retryPublishFailureBackoffMilliseconds: 200,
      topology,
    });
    consumers.push(consumer);
    await deleteRetryExchange(topology);
    const relay = new OutboxRelay("publisher-retry-outage", messagingRepository, publisher);

    expect(await relay.publishBatch()).toEqual({ claimed: 1, failed: 0, published: 1 });
    await waitFor(() => Promise.resolve(handlerCalls >= 2));
    await delay(450);
    expect(handlerCalls).toBeGreaterThanOrEqual(2);
    expect(handlerCalls).toBeLessThanOrEqual(4);

    consumers.splice(consumers.indexOf(consumer), 1);
    await consumer.close();
    await waitFor(async () => (await queueCount(topology.queue)) === 1);
    expect(await deadLetterCount(topology)).toBe(0);
    expect((await inboxState(accepted.outboxId)).attempts).toBeLessThanOrEqual(4);
  });

  it("acks delayed state, dead-letters poison data, and preserves Outbox on broker failure", async () => {
    const accepted = await createAcceptedExecution(runtimeRepository, "stale");
    await pool.query("UPDATE executions SET status = 'RUNNING' WHERE id = $1", [
      accepted.executionId,
    ]);
    await pool.query("UPDATE sessions SET status = 'RUNNING' WHERE id = $1", [accepted.sessionId]);
    const topology = newTopology("stale");
    const publisher = await createPublisher(topology);
    let handlerCalls = 0;
    await createConsumer(topology, () => {
      handlerCalls += 1;
      return Promise.resolve();
    });
    const relay = new OutboxRelay("publisher-stale", messagingRepository, publisher);
    expect(await relay.publishBatch()).toEqual({ claimed: 1, failed: 0, published: 1 });
    await waitFor(async () => (await inboxState(accepted.outboxId)).outcome === "IGNORED_STALE");
    expect(handlerCalls).toBe(0);

    await publishPoison(topology);
    await waitFor(async () => (await deadLetterCount(topology)) === 1);

    const second = await createAcceptedExecution(runtimeRepository, "broker-outage");
    const failingRelay = new OutboxRelay(
      "publisher-outage",
      messagingRepository,
      {
        publish: () => Promise.reject(new Error("broker unavailable")),
      },
      { retryDelay: () => 60_000 },
    );
    expect(await failingRelay.publishBatch()).toEqual({ claimed: 1, failed: 1, published: 0 });
    expect(await outboxState(second.outboxId)).toMatchObject({
      attempts: 1,
      last_error: "broker unavailable",
      published_at: null,
    });
  });

  it("runs the standalone relay loop and drains cleanly on SIGTERM", async () => {
    const accepted = await createAcceptedExecution(runtimeRepository, "relay-process");
    const topology = newTopology("relay-process");
    const child = spawn(
      join(repositoryRoot, "node_modules/.bin/tsx"),
      [join(repositoryRoot, "apps/outbox-relay/src/main.ts")],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          ITERM_DATABASE_URL: databaseUrl ?? "",
          ITERM_PUBLISHER_ID: "publisher-process-test",
          ITERM_QUEUE_PREFIX: topology.exchange.slice(0, -".runtime".length),
          ITERM_RABBITMQ_URL: rabbitMqUrl ?? "",
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    try {
      await waitFor(async () => (await outboxState(accepted.outboxId)).published_at !== null);
      child.kill("SIGTERM");
      const exit = await waitForExit(child);
      expect(exit).toEqual({ code: 0, signal: null });
      expect(stderr).toContain("iTerminal Outbox relay started");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  function newTopology(suffix: string): RabbitMqTopology {
    const topology = runtimeQueueTopology(
      `iterminal-test-${process.pid.toString()}-${suffix}-${randomUUID()}`,
    );
    topologies.push(topology);
    return topology;
  }

  async function createPublisher(topology: RabbitMqTopology): Promise<RabbitMqPublisher> {
    const publisher = await RabbitMqPublisher.connect(rabbitMqUrl ?? "", topology);
    publishers.push(publisher);
    return publisher;
  }

  async function createConsumer(
    topology: RabbitMqTopology,
    handler: () => Promise<void>,
  ): Promise<RabbitMqExecutionReadyConsumer> {
    const processor = new ExecutionReadyProcessor(
      "owner-router",
      messagingRepository,
      messagingRepository,
      handler,
      { maxAttempts: 3 },
    );
    const consumer = await RabbitMqExecutionReadyConsumer.connect(rabbitMqUrl ?? "", processor, {
      prefetch: 4,
      topology,
    });
    consumers.push(consumer);
    return consumer;
  }

  async function inboxState(messageId: string): Promise<InboxState> {
    const result = await pool.query<InboxState>(
      `SELECT status, attempts, outcome, last_error
         FROM consumer_inbox WHERE consumer_id = 'owner-router' AND message_id = $1`,
      [messageId],
    );
    return result.rows[0] ?? { attempts: 0, last_error: null, outcome: null, status: "MISSING" };
  }

  async function outboxState(messageId: string): Promise<OutboxState> {
    const result = await pool.query<OutboxState>(
      "SELECT attempts, published_at, last_error FROM outbox WHERE id = $1",
      [messageId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Missing Outbox row ${messageId}`);
    return row;
  }
});

interface InboxState {
  readonly attempts: number;
  readonly last_error: string | null;
  readonly outcome: string | null;
  readonly status: string;
}

interface OutboxState {
  readonly attempts: number;
  readonly last_error: string | null;
  readonly published_at: Date | null;
}

async function createAcceptedExecution(
  repository: PostgresRuntimeRepository,
  suffix: string,
): Promise<{
  readonly executionId: string;
  readonly outboxId: string;
  readonly sessionId: string;
}> {
  const sessionId = `ses_${suffix}_${randomUUID()}`;
  await repository.createReadySession({
    createdAt: new Date(),
    generation: 1,
    id: sessionId,
    integrationVersion: "m8-test",
    ownerId: "owner-m8",
    shell: "zsh",
    workspaceRoot: "/tmp",
  });
  const request = executeRequest(sessionId, suffix);
  await repository.acceptExecute(request);
  return { executionId: request.executionId, outboxId: request.outboxId, sessionId };
}

function executeRequest(sessionId: string, suffix: string): AcceptExecuteTransaction {
  return {
    acceptedAt: new Date(),
    actionId: `act_${suffix}_${randomUUID()}`,
    actor: {
      client: "m8-test",
      id: `actor_${suffix}`,
      principal: "m8-test",
      capabilities: ACTOR_CAPABILITY_PROFILES.system,
      type: "system",
    },
    command: "true",
    eventId: `evt_${suffix}_${randomUUID()}`,
    executionId: `exe_${suffix}_${randomUUID()}`,
    generation: 1,
    idempotencyKey: `m8-${suffix}`,
    outboxId: `out_${suffix}_${randomUUID()}`,
    requestHash: `hash-${suffix}`,
    sessionId,
  };
}

async function deleteTopology(topology: RabbitMqTopology): Promise<void> {
  const connection = await amqp.connect(rabbitMqUrl ?? "");
  const channel = await connection.createChannel();
  try {
    await channel.deleteQueue(topology.queue);
    await channel.deleteQueue(topology.retryQueue);
    await channel.deleteQueue(topology.deadLetterQueue);
    await channel.deleteExchange(topology.exchange);
    await channel.deleteExchange(topology.retryExchange);
    await channel.deleteExchange(topology.deadLetterExchange);
  } finally {
    await channel.close();
    await connection.close();
  }
}

async function publishPoison(topology: RabbitMqTopology): Promise<void> {
  await publishRaw(topology, Buffer.from("not-json", "utf8"), `poison_${randomUUID()}`);
}

async function publishRaw(
  topology: RabbitMqTopology,
  content: Buffer,
  messageId: string,
): Promise<void> {
  const connection = await amqp.connect(rabbitMqUrl ?? "");
  const channel = await connection.createConfirmChannel();
  try {
    await assertRuntimeQueueTopology(channel, topology);
    await publishConfirmed(channel, topology.exchange, topology.routingKey, content, { messageId });
  } finally {
    await channel.close();
    await connection.close();
  }
}

async function deadLetterCount(topology: RabbitMqTopology): Promise<number> {
  return queueCount(topology.deadLetterQueue);
}

async function queueCount(queue: string): Promise<number> {
  const connection: ChannelModel = await amqp.connect(rabbitMqUrl ?? "");
  const channel = await connection.createChannel();
  try {
    return (await channel.checkQueue(queue)).messageCount;
  } finally {
    await channel.close();
    await connection.close();
  }
}

async function deleteRetryExchange(topology: RabbitMqTopology): Promise<void> {
  const connection = await amqp.connect(rabbitMqUrl ?? "");
  const channel = await connection.createChannel();
  try {
    await channel.deleteExchange(topology.retryExchange);
  } finally {
    await channel.close();
    await connection.close();
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error("Timed out waiting for messaging state");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value to exist");
  return value;
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error("Relay process did not exit")), 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
