import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgresMessagingRepository } from "@iterminal/persistence-postgres";
import {
  RabbitMqPublisher,
  runtimeQueueTopology,
  type RabbitMqConnectionState,
  type RabbitMqTopology,
} from "@iterminal/queue-rabbitmq";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import amqp from "amqplib";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startOutboxRelay, type OutboxRelayHandle } from "../../outbox-relay/src/server.js";
import { startExecutionWorker, type ExecutionWorkerHandle } from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const clusterUrls = commaSeparated("ITERM_TEST_RABBITMQ_CLUSTER_URLS");
const clusterContainers = commaSeparated("ITERM_TEST_RABBITMQ_CLUSTER_CONTAINERS");
const describeQuorum =
  databaseUrl === undefined || clusterUrls.length !== 3 || clusterContainers.length !== 3
    ? describe.skip
    : describe;
const execFileAsync = promisify(execFile);

describeQuorum("M8.9 RabbitMQ quorum leader failover", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const messaging = new PostgresMessagingRepository(
    databaseUrl ?? "postgresql://localhost/iterminal_test",
  );

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M8.9 tests refuse to mutate any database except iterminal_test");
    }
    await messaging.migrate();
  });

  afterAll(async () => {
    await messaging.close();
    await pool.end();
  });

  it("elects a new leader and completes pending Outbox work without duplicate PTY writes", async () => {
    await pool.query("TRUNCATE sessions, actors, outbox, consumer_inbox RESTART IDENTITY CASCADE");
    let root = await mkdtemp(join(tmpdir(), "itm8-quorum-"));
    root = await realpath(root);
    const workspace = join(root, "workspace");
    const socketPath = join(root, "runtime.sock");
    const sideEffect = join(root, "side-effect.txt");
    await mkdir(workspace, { recursive: true });
    const queuePrefix = `iterminal-m8-quorum-${process.pid.toString()}-${randomUUID()}`;
    const topology = runtimeQueueTopology(queuePrefix);
    const ownerId = `owner-m8-quorum-${randomUUID()}`;
    const consumerId = `worker-m8-quorum-${randomUUID()}`;
    const workerStates: RabbitMqConnectionState[] = [];
    const publisherStates: RabbitMqConnectionState[] = [];
    let leaderContainer = "";
    let leaderStopped = false;
    let relay: OutboxRelayHandle | undefined;
    let worker: ExecutionWorkerHandle | undefined;
    let daemon: RuntimeDaemonHandle | undefined;
    let orderedUrls: readonly string[] = clusterUrls;
    try {
      const topologyPublisher = await RabbitMqPublisher.connect(clusterUrls[0] ?? "", topology, {
        heartbeatSeconds: 1,
      });
      await topologyPublisher.close();
      const initialStatus = await quorumStatus(topology.queue, clusterContainers);
      const initialLeader = required(
        initialStatus.find((row) => row["Raft State"] === "leader"),
        "initial quorum leader",
      );
      const leaderIndex = nodeIndex(initialLeader["Node Name"]);
      orderedUrls = moveFirst(clusterUrls, leaderIndex);
      const orderedContainers = moveFirst(clusterContainers, leaderIndex);
      leaderContainer = orderedContainers[0] ?? "";
      expect(initialStatus.filter((row) => row.Membership === "voter")).toHaveLength(3);

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
        rabbitMqHeartbeatSeconds: 1,
        rabbitMqReconnectInitialMilliseconds: 100,
        rabbitMqReconnectJitterRatio: 0,
        rabbitMqReconnectMaxMilliseconds: 500,
        rabbitMqUrl: orderedUrls,
        runtimeSocketPath: socketPath,
        onRabbitMqConnectionState: (state) => workerStates.push(state),
      });
      relay = await startOutboxRelay({
        databaseUrl: databaseUrl ?? "",
        pollMilliseconds: 50,
        publisherId: `publisher-m8-quorum-${randomUUID()}`,
        queuePrefix,
        rabbitMqHeartbeatSeconds: 1,
        rabbitMqReconnectInitialMilliseconds: 100,
        rabbitMqReconnectJitterRatio: 0,
        rabbitMqReconnectMaxMilliseconds: 500,
        rabbitMqUrl: orderedUrls,
        retryDelay: () => 100,
        onRabbitMqConnectionState: (state) => publisherStates.push(state),
      });
      await withTimeout(worker.waitUntilConnected(), 15_000, "initial Worker connection");

      const client = new UnixRuntimeClient(socketPath);
      const session = await client.createSession({ shell: "zsh", workspaceRoot: workspace });
      const before = await client.startExecute({
        actor,
        command: `printf 'before\n' >> ${shellQuote(sideEffect)}`,
        idempotencyKey: "before-quorum-failover",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      expect(
        (await withTimeout(client.waitExecution(before.execution.id), 30_000, "baseline")).status,
      ).toBe("COMPLETED");
      await waitFor(async () => (await outboxState(before.execution.id)).published_at !== null);
      expect(
        publisherStates.some((state) => state.state === "CONNECTED" && state.endpointIndex === 0),
      ).toBe(true);
      expect(
        workerStates.some((state) => state.state === "CONNECTED" && state.endpointIndex === 0),
      ).toBe(true);

      await stopContainer(leaderContainer);
      leaderStopped = true;
      expect(await containerRunning(leaderContainer)).toBe(false);
      await waitFor(
        () => Promise.resolve(workerStates.some((state) => state.state === "DISCONNECTED")),
        15_000,
      );

      const during = await client.startExecute({
        actor,
        command: `printf 'during\n' >> ${shellQuote(sideEffect)}`,
        idempotencyKey: "during-quorum-failover",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      expect(await readFile(sideEffect, "utf8")).toBe("before\n");
      const completed = await withTimeout(
        client.waitExecution(during.execution.id),
        45_000,
        "execution while former leader remains down",
      );
      expect(completed.status).toBe("COMPLETED");
      expect(await containerRunning(leaderContainer)).toBe(false);
      expect(await readFile(sideEffect, "utf8")).toBe("before\nduring\n");
      await waitFor(async () => (await outboxState(during.execution.id)).published_at !== null);

      const electedStatus = await quorumStatus(topology.queue, orderedContainers.slice(1));
      const electedLeader = required(
        electedStatus.find((row) => row["Raft State"] === "leader"),
        "replacement quorum leader",
      );
      expect(electedLeader["Node Name"]).not.toBe(initialLeader["Node Name"]);
      expect(
        electedStatus.filter((row) => row.Membership === "voter").length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        workerStates.some((state) => state.state === "CONNECTED" && state.endpointIndex !== 0),
      ).toBe(true);
      expect(
        publisherStates.some(
          (state) => state.state === "DISCONNECTED" && state.endpointIndex === 0,
        ),
      ).toBe(true);
      expect(
        publisherStates.some((state) => state.state === "CONNECTED" && state.endpointIndex !== 0),
      ).toBe(true);
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
      if (leaderStopped) {
        await startContainer(leaderContainer).catch((error: unknown) => cleanupErrors.push(error));
        await waitForRabbitMq(orderedUrls[0] ?? "").catch((error: unknown) =>
          cleanupErrors.push(error),
        );
      }
      if (relay !== undefined) {
        await withTimeout(relay.close(), 10_000, "Outbox relay stop").catch((error: unknown) =>
          cleanupErrors.push(error),
        );
      }
      if (worker !== undefined) {
        await withTimeout(worker.close(), 10_000, "Worker stop").catch((error: unknown) =>
          cleanupErrors.push(error),
        );
      }
      if (daemon !== undefined) {
        await withTimeout(daemon.close(), 10_000, "Runtime stop").catch((error: unknown) =>
          cleanupErrors.push(error),
        );
      }
      await deleteTopology(topology, orderedUrls).catch((error: unknown) =>
        cleanupErrors.push(error),
      );
      await rm(root, { force: true, recursive: true });
      expect(cleanupErrors, "M8.9 fixture cleanup failed").toEqual([]);
    }
  }, 120_000);

  async function outboxState(executionId: string): Promise<OutboxState> {
    const result = await pool.query<OutboxState>(
      `SELECT attempts, last_error, published_at
         FROM outbox
        WHERE payload ->> 'executionId' = $1`,
      [executionId],
    );
    return required(result.rows[0], `Outbox row for ${executionId}`);
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

interface QuorumStatusRow {
  readonly Membership: string;
  readonly "Node Name": string;
  readonly "Raft State": string;
}

const actor = {
  client: "m8-quorum-test",
  id: "agent-m8-quorum",
  principal: "m8-quorum-test",
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  type: "agent" as const,
};

async function quorumStatus(
  queue: string,
  containers: readonly string[],
): Promise<readonly QuorumStatusRow[]> {
  let lastError: unknown;
  for (const container of containers) {
    try {
      const result = await execFileAsync("docker", [
        "exec",
        container,
        "rabbitmq-queues",
        "quorum_status",
        "--vhost",
        "/",
        "--formatter",
        "json",
        queue,
      ]);
      return JSON.parse(result.stdout) as readonly QuorumStatusRow[];
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No RabbitMQ container was available for quorum status");
}

function nodeIndex(nodeName: string): number {
  const match = /rabbitmq([1-3])$/.exec(nodeName);
  if (match?.[1] === undefined) throw new Error(`Unexpected RabbitMQ node name: ${nodeName}`);
  return Number.parseInt(match[1], 10) - 1;
}

function moveFirst<T>(values: readonly T[], index: number): readonly T[] {
  const selected = values[index];
  if (selected === undefined)
    throw new Error(`Missing cluster member at index ${index.toString()}`);
  return [selected, ...values.filter((_value, candidate) => candidate !== index)];
}

async function stopContainer(container: string): Promise<void> {
  await execFileAsync("docker", ["stop", "--time", "1", container]);
}

async function startContainer(container: string): Promise<void> {
  await execFileAsync("docker", ["start", container]);
}

async function containerRunning(container: string): Promise<boolean> {
  const result = await execFileAsync("docker", [
    "inspect",
    "--format",
    "{{.State.Running}}",
    container,
  ]);
  return result.stdout.trim() === "true";
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

async function deleteTopology(topology: RabbitMqTopology, urls: readonly string[]): Promise<void> {
  let connection: Awaited<ReturnType<typeof amqp.connect>> | undefined;
  for (const url of urls) {
    try {
      connection = await amqp.connect(url, { timeout: 1_000 });
      break;
    } catch {
      // Try the next cluster endpoint.
    }
  }
  if (connection === undefined) throw new Error("No RabbitMQ endpoint available for cleanup");
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

function commaSeparated(name: string): readonly string[] {
  const value = process.env[name];
  return value === undefined
    ? []
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function required<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`Missing ${description}`);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
