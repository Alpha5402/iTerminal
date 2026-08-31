import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OutboxRelay } from "@iterminal/messaging";
import { PostgresMessagingRepository } from "@iterminal/persistence-postgres";
import {
  runtimeQueueTopology,
  SupervisedRabbitMqPublisher,
  type RabbitMqConnectionState,
  type RabbitMqTopology,
} from "@iterminal/queue-rabbitmq";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import amqp from "amqplib";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startExecutionWorker, type ExecutionWorkerHandle } from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const rabbitMqUrl = process.env.ITERM_RABBITMQ_URL;
const rabbitMqContainer = process.env.ITERM_TEST_RABBITMQ_CONTAINER;
const describeOutage =
  databaseUrl === undefined || rabbitMqUrl === undefined || rabbitMqContainer === undefined
    ? describe.skip
    : describe;
const execFileAsync = promisify(execFile);

describeOutage("M8.5 RabbitMQ process reconnect", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const messaging = new PostgresMessagingRepository(
    databaseUrl ?? "postgresql://localhost/iterminal_test",
  );

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M8.5 tests refuse to mutate any database except iterminal_test");
    }
    await messaging.migrate();
  });

  afterAll(async () => {
    await ensureContainerStarted(rabbitMqContainer ?? "");
    await messaging.close();
    await pool.end();
  });

  it("recovers relay and Worker after a broker process restart without duplicate PTY writes", async () => {
    await pool.query("TRUNCATE sessions, actors, outbox, consumer_inbox RESTART IDENTITY CASCADE");
    let root = await mkdtemp(join(tmpdir(), "itm8-broker-reconnect-"));
    root = await realpath(root);
    const workspace = join(root, "workspace");
    const socketPath = join(root, "runtime.sock");
    const sideEffect = join(root, "side-effect.txt");
    await mkdir(workspace, { recursive: true });
    const queuePrefix = `iterminal-m8-reconnect-${process.pid.toString()}-${randomUUID()}`;
    const topology = runtimeQueueTopology(queuePrefix);
    const ownerId = `owner-m8-reconnect-${randomUUID()}`;
    const consumerId = `worker-m8-reconnect-${randomUUID()}`;
    const workerStates: RabbitMqConnectionState[] = [];
    const publisherStates: RabbitMqConnectionState[] = [];
    const relayAbort = new AbortController();
    let relayTask: Promise<void> | undefined;
    let publisher: SupervisedRabbitMqPublisher | undefined;
    let worker: ExecutionWorkerHandle | undefined;
    let daemon: RuntimeDaemonHandle | undefined;
    let brokerStopped = false;
    try {
      daemon = await startRuntimeDaemon({
        databaseUrl: databaseUrl ?? "",
        executionDispatch: "external",
        ownerId,
        socketPath,
      });
      worker = await startExecutionWorker({
        consumerId,
        databaseUrl: databaseUrl ?? "",
        ownerId,
        queuePrefix,
        rabbitMqReconnectInitialMilliseconds: 100,
        rabbitMqReconnectMaxMilliseconds: 500,
        rabbitMqUrl: rabbitMqUrl ?? "",
        runtimeSocketPath: socketPath,
        onRabbitMqConnectionState: (state) => workerStates.push(state),
      });
      await withTimeout(worker.waitUntilConnected(), 15_000, "initial Worker connection");
      publisher = new SupervisedRabbitMqPublisher(rabbitMqUrl ?? "", topology, {
        initialDelayMilliseconds: 100,
        jitterRatio: 0,
        maxDelayMilliseconds: 500,
        onConnectionState: (state) => publisherStates.push(state),
      });
      const relay = new OutboxRelay("publisher-m8-reconnect", messaging, publisher, {
        batchSize: 4,
        pollMilliseconds: 50,
        retryDelay: () => 100,
      });
      relayTask = relay.run(relayAbort.signal);

      const client = new UnixRuntimeClient(socketPath);
      const session = await client.createSession({ shell: "zsh", workspaceRoot: workspace });
      const before = await client.startExecute({
        actor,
        command: `printf 'before\\n' >> ${shellQuote(sideEffect)}`,
        idempotencyKey: "before-broker-restart",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      await withTimeout(
        client.waitExecution(before.execution.id),
        30_000,
        "execution before broker restart",
      );
      await waitFor(async () => (await outboxState(before.execution.id)).published_at !== null);

      await stopContainer(rabbitMqContainer ?? "");
      brokerStopped = true;
      await waitFor(() =>
        Promise.resolve(workerStates.some((state) => state.state === "DISCONNECTED")),
      );

      const during = await client.startExecute({
        actor,
        command: `printf 'during\\n' >> ${shellQuote(sideEffect)}`,
        idempotencyKey: "during-broker-restart",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      await waitFor(async () => (await outboxState(during.execution.id)).last_error !== null);
      expect(await readFile(sideEffect, "utf8")).toBe("before\n");

      await startContainer(rabbitMqContainer ?? "");
      brokerStopped = false;
      await waitForRabbitMq(rabbitMqUrl ?? "");
      const completed = await withTimeout(
        client.waitExecution(during.execution.id),
        30_000,
        "execution after broker restart",
      );
      expect(completed.status).toBe("COMPLETED");
      expect(await readFile(sideEffect, "utf8")).toBe("before\nduring\n");
      await waitFor(async () => (await outboxState(during.execution.id)).published_at !== null);

      expect(
        workerStates.filter((state) => state.state === "CONNECTED").length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        publisherStates.filter((state) => state.state === "CONNECTED").length,
      ).toBeGreaterThanOrEqual(2);
      expect((await outboxState(during.execution.id)).attempts).toBeGreaterThanOrEqual(2);
      expect(await eventCount(session.id, during.execution.id, "execution.write_attempted")).toBe(
        1,
      );
      expect(await inboxAttempts(consumerId, during.execution.id)).toBe(1);
      await withTimeout(
        client.closeSession(session.id, session.generation),
        10_000,
        "Session close",
      );
    } finally {
      const cleanupErrors: unknown[] = [];
      if (brokerStopped) await ensureContainerStarted(rabbitMqContainer ?? "");
      relayAbort.abort();
      if (relayTask !== undefined) {
        await withTimeout(relayTask, 10_000, "Outbox relay stop").catch((error: unknown) =>
          cleanupErrors.push(error),
        );
      }
      if (publisher !== undefined) {
        await withTimeout(publisher.close(), 10_000, "publisher close").catch((error: unknown) =>
          cleanupErrors.push(error),
        );
      }
      if (worker !== undefined) {
        await withTimeout(worker.close(), 10_000, "Worker close").catch((error: unknown) =>
          cleanupErrors.push(error),
        );
      }
      if (daemon !== undefined) {
        await withTimeout(daemon.close(), 10_000, "Runtime close").catch((error: unknown) =>
          cleanupErrors.push(error),
        );
      }
      await withTimeout(deleteTopology(topology), 10_000, "topology cleanup").catch((error) =>
        cleanupErrors.push(error),
      );
      await rm(root, { force: true, recursive: true });
      expect(cleanupErrors, "M8.5 fixture cleanup failed").toEqual([]);
    }
  }, 90_000);

  it("starts degraded while RabbitMQ is down and connects without a Worker restart", async () => {
    const queuePrefix = `iterminal-m8-cold-reconnect-${process.pid.toString()}-${randomUUID()}`;
    const topology = runtimeQueueTopology(queuePrefix);
    const states: RabbitMqConnectionState[] = [];
    let worker: ExecutionWorkerHandle | undefined;
    let brokerStopped = false;
    try {
      await stopContainer(rabbitMqContainer ?? "");
      brokerStopped = true;
      worker = await startExecutionWorker({
        consumerId: `worker-m8-cold-reconnect-${randomUUID()}`,
        databaseUrl: databaseUrl ?? "",
        ownerId: `owner-m8-cold-reconnect-${randomUUID()}`,
        queuePrefix,
        rabbitMqReconnectInitialMilliseconds: 100,
        rabbitMqReconnectMaxMilliseconds: 500,
        rabbitMqUrl: rabbitMqUrl ?? "",
        runtimeSocketPath: join(tmpdir(), "iterminal-m8-unused-runtime.sock"),
        onRabbitMqConnectionState: (state) => states.push(state),
      });
      await waitFor(() => Promise.resolve(states.some((state) => state.state === "DISCONNECTED")));
      expect(worker.connectionState().state).not.toBe("CONNECTED");

      await startContainer(rabbitMqContainer ?? "");
      brokerStopped = false;
      await waitForRabbitMq(rabbitMqUrl ?? "");
      await withTimeout(worker.waitUntilConnected(), 30_000, "cold-start Worker reconnect");
      expect(worker.connectionState().state).toBe("CONNECTED");
      expect(states.some((state) => state.state === "DISCONNECTED")).toBe(true);
    } finally {
      if (brokerStopped) await ensureContainerStarted(rabbitMqContainer ?? "");
      await worker?.close().catch(() => undefined);
      await deleteTopology(topology).catch(() => undefined);
    }
  }, 60_000);

  async function outboxState(executionId: string): Promise<OutboxState> {
    const result = await pool.query<OutboxState>(
      `SELECT attempts, last_error, published_at
         FROM outbox
        WHERE payload ->> 'executionId' = $1`,
      [executionId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Missing Outbox row for ${executionId}`);
    return row;
  }

  async function eventCount(
    sessionId: string,
    executionId: string,
    eventType: string,
  ): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*) FROM session_events
        WHERE session_id = $1 AND execution_id = $2 AND event_type = $3`,
      [sessionId, executionId, eventType],
    );
    return Number.parseInt(result.rows[0]?.count ?? "0", 10);
  }

  async function inboxAttempts(consumerId: string, executionId: string): Promise<number> {
    const result = await pool.query<{ attempts: number }>(
      `SELECT ci.attempts
         FROM consumer_inbox ci
         JOIN outbox o ON o.id = ci.message_id
        WHERE ci.consumer_id = $1 AND o.payload ->> 'executionId' = $2`,
      [consumerId, executionId],
    );
    return result.rows[0]?.attempts ?? 0;
  }
});

interface OutboxState {
  readonly attempts: number;
  readonly last_error: string | null;
  readonly published_at: Date | null;
}

const actor = {
  client: "m8-reconnect-test",
  id: "agent-m8-reconnect",
  principal: "m8-reconnect-test",
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  type: "agent" as const,
};

async function stopContainer(container: string): Promise<void> {
  await execFileAsync("docker", ["stop", "--time", "1", container]);
}

async function startContainer(container: string): Promise<void> {
  await execFileAsync("docker", ["start", container]);
}

async function ensureContainerStarted(container: string): Promise<void> {
  if (container.length === 0) return;
  await startContainer(container).catch(() => undefined);
  await waitForRabbitMq(rabbitMqUrl ?? "").catch(() => undefined);
}

async function waitForRabbitMq(url: string): Promise<void> {
  await waitFor(async () => {
    try {
      const connection = await amqp.connect(url, { timeout: 500 });
      await connection.close();
      return true;
    } catch {
      return false;
    }
  }, 30_000);
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

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMilliseconds = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Condition was not met within ${timeoutMilliseconds.toString()}ms`);
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMilliseconds: number,
  operation: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${operation} timed out after ${timeoutMilliseconds.toString()}ms`)),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
