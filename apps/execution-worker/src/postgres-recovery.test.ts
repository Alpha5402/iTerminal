import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { PostgresMessagingRepository } from "@iterminal/persistence-postgres";
import { runtimeQueueTopology, type RabbitMqTopology } from "@iterminal/queue-rabbitmq";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import amqp from "amqplib";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const rabbitMqUrl = process.env.ITERM_RABBITMQ_URL;
const postgresContainer = process.env.ITERM_TEST_POSTGRES_CONTAINER;
const describeRecovery =
  databaseUrl === undefined || rabbitMqUrl === undefined || postgresContainer === undefined
    ? describe.skip
    : describe;
const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");

describeRecovery("M8.7 messaging-loop PostgreSQL recovery", () => {
  beforeAll(async () => {
    const database = await queryDatabase<{ current_database: string }>("SELECT current_database()");
    if (database[0]?.current_database !== "iterminal_test") {
      throw new Error("M8.7 tests refuse to mutate any database except iterminal_test");
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
    await ensureContainerStarted(postgresContainer ?? "");
  });

  it("keeps running relay and Worker processes alive across a database restart", async () => {
    const fixture = await createFixture("running");
    const queuePrefix = createQueuePrefix("running");
    const topology = runtimeQueueTopology(queuePrefix);
    const ownerId = `owner-m8-db-loops-${randomUUID()}`;
    const consumerId = `worker-m8-db-loops-${randomUUID()}`;
    let daemon: RuntimeDaemonHandle | undefined;
    let relay: ManagedChild | undefined;
    let worker: ManagedChild | undefined;
    let databaseStopped = false;
    try {
      daemon = await startRuntimeDaemon({
        databaseHealthCheckMilliseconds: 100,
        databaseReconnectInitialMilliseconds: 100,
        databaseReconnectJitterRatio: 0,
        databaseReconnectMaxMilliseconds: 500,
        databaseStatementTimeoutMilliseconds: 1_000,
        databaseUrl: databaseUrl ?? "",
        executionDispatch: "external",
        ownerId,
        socketPath: fixture.socketPath,
      });
      [relay, worker] = await Promise.all([
        startService("apps/outbox-relay/src/main.ts", "iTerminal Outbox relay started", {
          ITERM_PUBLISHER_ID: `publisher-m8-db-loops-${randomUUID()}`,
          ITERM_QUEUE_PREFIX: queuePrefix,
        }),
        startService("apps/execution-worker/src/main.ts", "iTerminal Execution worker started", {
          ITERM_CONSUMER_ID: consumerId,
          ITERM_QUEUE_PREFIX: queuePrefix,
          ITERM_RUNTIME_OWNER_ID: ownerId,
          ITERM_RUNTIME_SOCKET: fixture.socketPath,
        }),
      ]);
      await waitFor(() =>
        Promise.resolve(
          relay?.stderr.includes("Outbox relay PostgreSQL connected") === true &&
            worker?.stderr.includes("Execution worker PostgreSQL connected") === true &&
            worker.stderr.includes("Execution worker RabbitMQ connected"),
        ),
      );

      const client = new UnixRuntimeClient(fixture.socketPath);
      const original = await client.createSession({
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      });
      const before = await client.startExecute({
        actor,
        command: `printf 'before-db-restart\\n' >> ${shellQuote(fixture.sideEffect)}`,
        idempotencyKey: "before-loop-database-restart",
        sessionGeneration: original.generation,
        sessionId: original.id,
      });
      expect(
        await withTimeout(
          client.waitExecution(before.execution.id),
          20_000,
          "execution before database restart",
        ),
      ).toMatchObject({ status: "COMPLETED" });
      await waitFor(async () => (await outboxState(before.execution.id)).published_at !== null);

      const relayConnections = occurrences(relay.stderr, "Outbox relay PostgreSQL connected");
      const workerConnections = occurrences(worker.stderr, "Execution worker PostgreSQL connected");
      const rabbitConnections = occurrences(worker.stderr, "Execution worker RabbitMQ connected");
      await stopContainer(postgresContainer ?? "");
      databaseStopped = true;
      await waitFor(() =>
        Promise.resolve(
          relay?.stderr.includes("Outbox relay PostgreSQL disconnected") === true &&
            worker?.stderr.includes("Execution worker PostgreSQL disconnected") === true &&
            daemon?.runtime.isDurabilityHealthy() === false,
        ),
      ).catch((error: unknown) => {
        throw new Error(
          `Running loop outage detection failed: ${error instanceof Error ? error.message : String(error)}\ndaemonHealthy=${String(daemon?.runtime.isDurabilityHealthy())}\nrelay:\n${relay?.stderr ?? "missing"}\nworker:\n${worker?.stderr ?? "missing"}`,
        );
      });
      expect(relay.process.exitCode, relay.stderr).toBeNull();
      expect(worker.process.exitCode, worker.stderr).toBeNull();

      await startContainer(postgresContainer ?? "");
      databaseStopped = false;
      await waitForPostgres();
      await withTimeout(daemon.waitUntilReady(), 30_000, "Runtime database recovery");
      await waitFor(() =>
        Promise.resolve(
          occurrences(relay?.stderr ?? "", "Outbox relay PostgreSQL connected") >
            relayConnections &&
            occurrences(worker?.stderr ?? "", "Execution worker PostgreSQL connected") >
              workerConnections &&
            occurrences(worker?.stderr ?? "", "Execution worker RabbitMQ connected") >
              rabbitConnections,
        ),
      );
      expect(daemon.runtime.getSession(original.id).status).toBe("BROKEN");

      const replacement = await client.createSession({
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      });
      const after = await client.startExecute({
        actor,
        command: `printf 'after-db-restart\\n' >> ${shellQuote(fixture.sideEffect)}`,
        idempotencyKey: "after-loop-database-restart",
        sessionGeneration: replacement.generation,
        sessionId: replacement.id,
      });
      expect(
        await withTimeout(
          client.waitExecution(after.execution.id),
          20_000,
          "execution after database restart",
        ),
      ).toMatchObject({ status: "COMPLETED" });
      await waitFor(async () => (await outboxState(after.execution.id)).published_at !== null);
      expect(await readFile(fixture.sideEffect, "utf8")).toBe(
        "before-db-restart\nafter-db-restart\n",
      );
      expect(await inboxAttempts(consumerId, after.execution.id)).toBe(1);
      await client.closeSession(replacement.id, replacement.generation);
    } finally {
      if (databaseStopped) await ensureContainerStarted(postgresContainer ?? "");
      await stopChild(worker).catch(() => undefined);
      await stopChild(relay).catch(() => undefined);
      await daemon?.close().catch(() => undefined);
      await deleteTopology(topology).catch(() => undefined);
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 90_000);

  it("starts both loops degraded and defers RabbitMQ consumption until PostgreSQL returns", async () => {
    const fixture = await createFixture("cold");
    const queuePrefix = createQueuePrefix("cold");
    const topology = runtimeQueueTopology(queuePrefix);
    const ownerId = `owner-m8-db-cold-${randomUUID()}`;
    const consumerId = `worker-m8-db-cold-${randomUUID()}`;
    let daemon: RuntimeDaemonHandle | undefined;
    let relay: ManagedChild | undefined;
    let worker: ManagedChild | undefined;
    let databaseStopped = false;
    try {
      await stopContainer(postgresContainer ?? "");
      databaseStopped = true;
      const [startedDaemon, startedRelay, startedWorker] = await Promise.all([
        startRuntimeDaemon({
          databaseHealthCheckMilliseconds: 100,
          databaseReconnectInitialMilliseconds: 100,
          databaseReconnectJitterRatio: 0,
          databaseReconnectMaxMilliseconds: 500,
          databaseStatementTimeoutMilliseconds: 500,
          databaseUrl: databaseUrl ?? "",
          executionDispatch: "external",
          ownerId,
          socketPath: fixture.socketPath,
        }),
        startService("apps/outbox-relay/src/main.ts", "iTerminal Outbox relay started", {
          ITERM_PUBLISHER_ID: `publisher-m8-db-cold-${randomUUID()}`,
          ITERM_QUEUE_PREFIX: queuePrefix,
        }),
        startService("apps/execution-worker/src/main.ts", "iTerminal Execution worker started", {
          ITERM_CONSUMER_ID: consumerId,
          ITERM_QUEUE_PREFIX: queuePrefix,
          ITERM_RUNTIME_OWNER_ID: ownerId,
          ITERM_RUNTIME_SOCKET: fixture.socketPath,
        }),
      ]);
      daemon = startedDaemon;
      relay = startedRelay;
      worker = startedWorker;
      expect(daemon.durabilityState().phase).not.toBe("READY");
      expect(relay.stderr).toContain("Outbox relay PostgreSQL disconnected");
      expect(worker.stderr).toContain("Execution worker PostgreSQL disconnected");
      expect(worker.stderr).not.toContain("Execution worker RabbitMQ connected");
      expect(relay.process.exitCode).toBeNull();
      expect(worker.process.exitCode).toBeNull();

      await startContainer(postgresContainer ?? "");
      databaseStopped = false;
      await waitForPostgres();
      await withTimeout(daemon.waitUntilReady(), 30_000, "cold Runtime database recovery");
      await waitFor(() =>
        Promise.resolve(
          relay?.stderr.includes("Outbox relay PostgreSQL connected") === true &&
            worker?.stderr.includes("Execution worker PostgreSQL connected") === true &&
            worker.stderr.includes("Execution worker RabbitMQ connected"),
        ),
      ).catch((error: unknown) => {
        throw new Error(
          `Cold loop recovery failed: ${error instanceof Error ? error.message : String(error)}\nrelay:\n${relay?.stderr ?? "missing"}\nworker:\n${worker?.stderr ?? "missing"}`,
        );
      });

      const client = new UnixRuntimeClient(fixture.socketPath);
      const session = await client.createSession({
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      });
      const execution = await client.startExecute({
        actor,
        command: `printf 'cold-db-recovered\\n' >> ${shellQuote(fixture.sideEffect)}`,
        idempotencyKey: "cold-loop-database-recovery",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      expect(
        await withTimeout(
          client.waitExecution(execution.execution.id),
          20_000,
          "cold database recovered execution",
        ),
      ).toMatchObject({ status: "COMPLETED" });
      await waitFor(async () => (await outboxState(execution.execution.id)).published_at !== null);
      expect(await readFile(fixture.sideEffect, "utf8")).toBe("cold-db-recovered\n");
      expect(await inboxAttempts(consumerId, execution.execution.id)).toBe(1);
      await client.closeSession(session.id, session.generation);
    } finally {
      if (databaseStopped) await ensureContainerStarted(postgresContainer ?? "");
      await stopChild(worker).catch(() => undefined);
      await stopChild(relay).catch(() => undefined);
      await daemon?.close().catch(() => undefined);
      await deleteTopology(topology).catch(() => undefined);
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 90_000);
});

const actor = {
  client: "m8-loop-postgres-test",
  id: "agent-m8-loop-postgres",
  principal: "m8-loop-postgres-test",
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  type: "agent" as const,
};

interface ManagedChild {
  readonly process: ChildProcessWithoutNullStreams;
  readonly stderr: string;
}

async function startService(
  entrypoint: string,
  readyText: string,
  environment: Readonly<Record<string, string>>,
): Promise<ManagedChild> {
  const child = spawn(process.execPath, ["--import", "tsx", join(repositoryRoot, entrypoint)], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ITERM_DATABASE_HEALTH_CHECK_MS: "100",
      ITERM_DATABASE_RECONNECT_INITIAL_MS: "100",
      ITERM_DATABASE_RECONNECT_MAX_MS: "500",
      ITERM_DATABASE_URL: databaseUrl ?? "",
      ITERM_RABBITMQ_RECONNECT_INITIAL_MS: "100",
      ITERM_RABBITMQ_RECONNECT_MAX_MS: "500",
      ITERM_RABBITMQ_URL: rabbitMqUrl ?? "",
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const managed: ManagedChild = {
    process: child,
    get stderr() {
      return stderr;
    },
  };
  await waitFor(() => Promise.resolve(stderr.includes(readyText) || child.exitCode !== null));
  if (child.exitCode !== null) {
    throw new Error(`${entrypoint} exited before ready (${child.exitCode.toString()}): ${stderr}`);
  }
  return managed;
}

async function stopChild(child: ManagedChild | undefined): Promise<void> {
  if (child === undefined || child.process.exitCode !== null || child.process.signalCode !== null) {
    return;
  }
  child.process.kill("SIGTERM");
  try {
    await withTimeout(waitForExit(child.process), 10_000, "service process shutdown");
  } catch (error) {
    child.process.kill("SIGKILL");
    await waitForExit(child.process);
    throw error;
  }
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

async function createFixture(suffix: string): Promise<{
  readonly root: string;
  readonly sideEffect: string;
  readonly socketPath: string;
  readonly workspace: string;
}> {
  let root = await mkdtemp(join("/private/tmp", `itm8-loop-db-${suffix}-`));
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
  return `iterminal-m8-loop-db-${suffix}-${process.pid.toString()}-${randomUUID()}`;
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

async function outboxState(executionId: string): Promise<{ published_at: Date | null }> {
  const rows = await queryDatabase<{ published_at: Date | null }>(
    "SELECT published_at FROM outbox WHERE payload ->> 'executionId' = $1",
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

async function stopContainer(container: string): Promise<void> {
  await execFileAsync("docker", ["stop", "--time", "1", container]);
}

async function startContainer(container: string): Promise<void> {
  await execFileAsync("docker", ["start", container]);
}

async function ensureContainerStarted(container: string): Promise<void> {
  if (container.length === 0) return;
  await startContainer(container).catch(() => undefined);
  await waitForPostgres().catch(() => undefined);
}

async function waitForPostgres(): Promise<void> {
  await waitFor(async () => {
    try {
      await queryDatabase("SELECT 1");
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
    await channel.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
  }
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
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
  throw new Error("Timed out waiting for M8.7 condition");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMilliseconds: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
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
