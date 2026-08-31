import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PostgresMessagingRepository } from "@iterminal/persistence-postgres";
import { runtimeQueueTopology, type RabbitMqTopology } from "@iterminal/queue-rabbitmq";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { startTcpFaultProxy, type TcpFaultProxy } from "@iterminal/testkit";
import amqp from "amqplib";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startOutboxRelay, type OutboxRelayHandle } from "../../outbox-relay/src/server.js";
import { startExecutionWorker, type ExecutionWorkerHandle } from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const rabbitMqUrl = process.env.ITERM_RABBITMQ_URL;
const describePartition =
  databaseUrl === undefined || rabbitMqUrl === undefined ? describe.skip : describe;

describePartition("M8.8 silent network blackhole recovery", () => {
  beforeAll(async () => {
    const database = await queryDatabase<{ current_database: string }>("SELECT current_database()");
    if (database[0]?.current_database !== "iterminal_test") {
      throw new Error("M8.8 tests refuse to mutate any database except iterminal_test");
    }
    const repository = new PostgresMessagingRepository(databaseUrl ?? "");
    try {
      await repository.migrate();
    } finally {
      await repository.close();
    }
  });

  beforeEach(async () => {
    await queryDatabase(
      "TRUNCATE sessions, actors, outbox, consumer_inbox RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    await waitForRabbitMq(rabbitMqUrl ?? "");
  });

  it("detects a RabbitMQ blackhole by heartbeat and dispatches pending Outbox work once", async () => {
    const fixture = await createFixture("rabbit");
    const queuePrefix = createQueuePrefix("rabbit");
    const topology = runtimeQueueTopology(queuePrefix);
    const ownerId = `owner-m8-rabbit-blackhole-${randomUUID()}`;
    const consumerId = `worker-m8-rabbit-blackhole-${randomUUID()}`;
    let daemon: RuntimeDaemonHandle | undefined;
    let relay: OutboxRelayHandle | undefined;
    let worker: ExecutionWorkerHandle | undefined;
    let proxy: TcpFaultProxy | undefined;
    try {
      proxy = await proxyFor(rabbitMqUrl ?? "");
      const proxiedRabbitMqUrl = throughProxy(rabbitMqUrl ?? "", proxy);
      daemon = await startRuntimeDaemon({
        databaseUrl: databaseUrl ?? "",
        executionDispatch: "external",
        ownerId,
        socketPath: fixture.socketPath,
      });
      const workerStates: string[] = [];
      const publisherStates: string[] = [];
      relay = await startOutboxRelay({
        databaseUrl: databaseUrl ?? "",
        pollMilliseconds: 50,
        publisherId: `publisher-m8-rabbit-blackhole-${randomUUID()}`,
        queuePrefix,
        rabbitMqHeartbeatSeconds: 1,
        rabbitMqReconnectInitialMilliseconds: 100,
        rabbitMqReconnectJitterRatio: 0,
        rabbitMqReconnectMaxMilliseconds: 500,
        rabbitMqUrl: proxiedRabbitMqUrl,
        retryDelay: () => 100,
        onRabbitMqConnectionState: (state) => publisherStates.push(state.state),
      });
      worker = await startExecutionWorker({
        consumerId,
        databaseUrl: databaseUrl ?? "",
        ownerId,
        queuePrefix,
        rabbitMqHeartbeatSeconds: 1,
        rabbitMqReconnectInitialMilliseconds: 100,
        rabbitMqReconnectJitterRatio: 0,
        rabbitMqReconnectMaxMilliseconds: 500,
        rabbitMqUrl: proxiedRabbitMqUrl,
        runtimeSocketPath: fixture.socketPath,
        onRabbitMqConnectionState: (state) => workerStates.push(state.state),
      });
      await withTimeout(worker.waitUntilConnected(), 15_000, "initial Worker connection");

      const client = new UnixRuntimeClient(fixture.socketPath);
      const session = await client.createSession({
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      });
      const before = await client.startExecute({
        actor,
        command: `printf 'before-rabbit-blackhole\\n' >> ${shellQuote(fixture.sideEffect)}`,
        idempotencyKey: "before-rabbit-blackhole",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      expect(
        await withTimeout(
          client.waitExecution(before.execution.id),
          20_000,
          "execution before RabbitMQ blackhole",
        ),
      ).toMatchObject({ status: "COMPLETED" });
      await waitFor(async () => (await outboxState(before.execution.id)).published_at !== null);
      const workerConnectedCount = workerStates.filter((state) => state === "CONNECTED").length;
      const publisherConnectedCount = publisherStates.filter(
        (state) => state === "CONNECTED",
      ).length;

      const partitionStartedAt = Date.now();
      proxy.setMode("BLACKHOLE");
      await waitFor(() => Promise.resolve(workerStates.includes("DISCONNECTED")), 8_000);
      expect(Date.now() - partitionStartedAt).toBeLessThan(8_000);

      const during = await client.startExecute({
        actor,
        command: `printf 'during-rabbit-blackhole\\n' >> ${shellQuote(fixture.sideEffect)}`,
        idempotencyKey: "during-rabbit-blackhole",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      await waitFor(
        async () => (await outboxState(during.execution.id)).last_error !== null,
        10_000,
      );
      expect(await readFile(fixture.sideEffect, "utf8")).toBe("before-rabbit-blackhole\n");

      proxy.setMode("FORWARD");
      const completed = await withTimeout(
        client.waitExecution(during.execution.id),
        30_000,
        "execution after RabbitMQ blackhole",
      );
      expect(completed.status).toBe("COMPLETED");
      await waitFor(async () => (await outboxState(during.execution.id)).published_at !== null);
      await waitFor(() =>
        Promise.resolve(
          workerStates.filter((state) => state === "CONNECTED").length > workerConnectedCount &&
            publisherStates.filter((state) => state === "CONNECTED").length >
              publisherConnectedCount,
        ),
      );
      expect(await readFile(fixture.sideEffect, "utf8")).toBe(
        "before-rabbit-blackhole\nduring-rabbit-blackhole\n",
      );
      expect((await outboxState(during.execution.id)).attempts).toBeGreaterThanOrEqual(2);
      expect(await inboxAttempts(consumerId, during.execution.id)).toBe(1);
      expect(await eventCount(session.id, during.execution.id, "execution.write_attempted")).toBe(
        1,
      );
      await client.closeSession(session.id, session.generation);
    } finally {
      if (proxy?.mode() === "BLACKHOLE") proxy.setMode("FORWARD");
      await relay?.close().catch(() => undefined);
      await worker?.close().catch(() => undefined);
      await daemon?.close().catch(() => undefined);
      await proxy?.close().catch(() => undefined);
      await deleteTopology(topology).catch(() => undefined);
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 90_000);

  it("bounds PostgreSQL blackhole detection and reconciles before replacement admission", async () => {
    const fixture = await createFixture("postgres");
    const queuePrefix = createQueuePrefix("postgres");
    const topology = runtimeQueueTopology(queuePrefix);
    const ownerId = `owner-m8-postgres-blackhole-${randomUUID()}`;
    const consumerId = `worker-m8-postgres-blackhole-${randomUUID()}`;
    let daemon: RuntimeDaemonHandle | undefined;
    let relay: OutboxRelayHandle | undefined;
    let worker: ExecutionWorkerHandle | undefined;
    let proxy: TcpFaultProxy | undefined;
    try {
      proxy = await proxyFor(databaseUrl ?? "");
      const proxiedDatabaseUrl = throughProxy(databaseUrl ?? "", proxy);
      daemon = await startRuntimeDaemon({
        databaseHealthCheckMilliseconds: 100,
        databaseReconnectInitialMilliseconds: 100,
        databaseReconnectJitterRatio: 0,
        databaseReconnectMaxMilliseconds: 500,
        databaseStatementTimeoutMilliseconds: 1_000,
        databaseUrl: proxiedDatabaseUrl,
        executionDispatch: "external",
        ownerId,
        socketPath: fixture.socketPath,
      });
      relay = await startOutboxRelay({
        databaseConnectionTimeoutMilliseconds: 1_000,
        databaseHealthCheckMilliseconds: 100,
        databaseOperationTimeoutMilliseconds: 1_000,
        databaseReconnectInitialMilliseconds: 100,
        databaseReconnectJitterRatio: 0,
        databaseReconnectMaxMilliseconds: 500,
        databaseUrl: proxiedDatabaseUrl,
        pollMilliseconds: 50,
        publisherId: `publisher-m8-postgres-blackhole-${randomUUID()}`,
        queuePrefix,
        rabbitMqHeartbeatSeconds: 1,
        rabbitMqUrl: rabbitMqUrl ?? "",
      });
      worker = await startExecutionWorker({
        consumerId,
        databaseConnectionTimeoutMilliseconds: 1_000,
        databaseHealthCheckMilliseconds: 100,
        databaseOperationTimeoutMilliseconds: 1_000,
        databaseReconnectInitialMilliseconds: 100,
        databaseReconnectJitterRatio: 0,
        databaseReconnectMaxMilliseconds: 500,
        databaseUrl: proxiedDatabaseUrl,
        ownerId,
        queuePrefix,
        rabbitMqHeartbeatSeconds: 1,
        rabbitMqUrl: rabbitMqUrl ?? "",
        runtimeSocketPath: fixture.socketPath,
      });
      await withTimeout(worker.waitUntilConnected(), 15_000, "initial blackhole Worker connection");

      const client = new UnixRuntimeClient(fixture.socketPath);
      const original = await client.createSession({
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      });
      const before = await client.startExecute({
        actor,
        command: `printf 'before-postgres-blackhole\\n' >> ${shellQuote(fixture.sideEffect)}`,
        idempotencyKey: "before-postgres-blackhole",
        sessionGeneration: original.generation,
        sessionId: original.id,
      });
      expect(
        await withTimeout(
          client.waitExecution(before.execution.id),
          20_000,
          "execution before PostgreSQL blackhole",
        ),
      ).toMatchObject({ status: "COMPLETED" });
      await waitFor(async () => (await outboxState(before.execution.id)).published_at !== null);

      const partitionStartedAt = Date.now();
      proxy.setMode("BLACKHOLE");
      await waitFor(
        () =>
          Promise.resolve(
            daemon?.runtime.isDurabilityHealthy() === false &&
              relay?.databaseState().state === "DISCONNECTED" &&
              worker?.databaseState().state === "DISCONNECTED",
          ),
        8_000,
      );
      expect(Date.now() - partitionStartedAt).toBeLessThan(8_000);
      await expect(
        client.createSession({ shell: "zsh", workspaceRoot: fixture.workspace }),
      ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", retryable: true });
      expect(await readFile(fixture.sideEffect, "utf8")).toBe("before-postgres-blackhole\n");

      proxy.setMode("FORWARD");
      await withTimeout(daemon.waitUntilReady(), 30_000, "Runtime blackhole recovery");
      await withTimeout(relay.waitUntilDatabaseReady(), 30_000, "relay blackhole recovery");
      await withTimeout(worker.waitUntilConnected(), 30_000, "Worker blackhole recovery");
      expect(daemon.runtime.getSession(original.id).status).toBe("BROKEN");

      const replacement = await client.createSession({
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      });
      const after = await client.startExecute({
        actor,
        command: `printf 'after-postgres-blackhole\\n' >> ${shellQuote(fixture.sideEffect)}`,
        idempotencyKey: "after-postgres-blackhole",
        sessionGeneration: replacement.generation,
        sessionId: replacement.id,
      });
      expect(
        await withTimeout(
          client.waitExecution(after.execution.id),
          30_000,
          "execution after PostgreSQL blackhole",
        ),
      ).toMatchObject({ status: "COMPLETED" });
      await waitFor(async () => (await outboxState(after.execution.id)).published_at !== null);
      expect(await readFile(fixture.sideEffect, "utf8")).toBe(
        "before-postgres-blackhole\nafter-postgres-blackhole\n",
      );
      expect(await inboxAttempts(consumerId, after.execution.id)).toBe(1);
      await client.closeSession(replacement.id, replacement.generation);
    } finally {
      if (proxy?.mode() === "BLACKHOLE") proxy.setMode("FORWARD");
      await relay?.close().catch(() => undefined);
      await worker?.close().catch(() => undefined);
      await daemon?.close().catch(() => undefined);
      await proxy?.close().catch(() => undefined);
      await deleteTopology(topology).catch(() => undefined);
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 90_000);
});

const actor = {
  client: "m8-network-partition-test",
  id: "agent-m8-network-partition",
  principal: "m8-network-partition-test",
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  type: "agent" as const,
};

async function proxyFor(url: string): Promise<TcpFaultProxy> {
  const parsed = new URL(url);
  const upstreamPort = Number.parseInt(
    parsed.port || (parsed.protocol === "amqp:" ? "5672" : "5432"),
    10,
  );
  return startTcpFaultProxy({ upstreamHost: parsed.hostname, upstreamPort });
}

function throughProxy(url: string, proxy: TcpFaultProxy): string {
  const parsed = new URL(url);
  parsed.hostname = proxy.host;
  parsed.port = proxy.port.toString();
  return parsed.toString();
}

async function createFixture(suffix: string): Promise<{
  readonly root: string;
  readonly sideEffect: string;
  readonly socketPath: string;
  readonly workspace: string;
}> {
  let root = await mkdtemp(join(tmpdir(), `itm8-net-${suffix}-`));
  root = await realpath(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return {
    root,
    sideEffect: join(root, "side-effect.txt"),
    socketPath: join(root, "runtime.sock"),
    workspace,
  };
}

function createQueuePrefix(suffix: string): string {
  return `iterminal-m8-net-${suffix}-${process.pid.toString()}-${randomUUID()}`;
}

async function queryDatabase<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000, max: 1 });
  pool.on("error", () => undefined);
  try {
    const result = await pool.query<T>(text, [...values]);
    return result.rows;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

interface OutboxState extends Record<string, unknown> {
  readonly attempts: number;
  readonly last_error: string | null;
  readonly published_at: Date | null;
}

async function outboxState(executionId: string): Promise<OutboxState> {
  const rows = await queryDatabase<OutboxState>(
    `SELECT attempts, last_error, published_at
       FROM outbox
      WHERE payload ->> 'executionId' = $1`,
    [executionId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`Missing Outbox row for ${executionId}`);
  return row;
}

async function inboxAttempts(consumerId: string, executionId: string): Promise<number> {
  const rows = await queryDatabase<{ attempts: number }>(
    `SELECT ci.attempts
       FROM consumer_inbox ci
       JOIN outbox o ON o.id = ci.message_id
      WHERE ci.consumer_id = $1 AND o.payload ->> 'executionId' = $2`,
    [consumerId, executionId],
  );
  return rows[0]?.attempts ?? 0;
}

async function eventCount(
  sessionId: string,
  executionId: string,
  eventType: string,
): Promise<number> {
  const rows = await queryDatabase<{ count: string }>(
    `SELECT count(*)
       FROM session_events
      WHERE session_id = $1 AND execution_id = $2 AND event_type = $3`,
    [sessionId, executionId, eventType],
  );
  return Number.parseInt(rows[0]?.count ?? "0", 10);
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
    await channel.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
  }
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
  });
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMilliseconds = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Condition was not met within ${timeoutMilliseconds.toString()}ms`);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMilliseconds: number,
  operation: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
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
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
