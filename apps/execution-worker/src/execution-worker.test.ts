import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { OutboxRelay } from "@iterminal/messaging";
import { PostgresMessagingRepository } from "@iterminal/persistence-postgres";
import { RabbitMqPublisher, runtimeQueueTopology } from "@iterminal/queue-rabbitmq";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import amqp from "amqplib";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startExecutionWorker, type ExecutionWorkerHandle } from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const rabbitMqUrl = process.env.ITERM_RABBITMQ_URL;
const describeDispatch =
  databaseUrl === undefined || rabbitMqUrl === undefined ? describe.skip : describe;
const repositoryRoot = resolve(import.meta.dirname, "../../..");

describeDispatch("M8.2 owner-local Execution dispatch", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const messaging = new PostgresMessagingRepository(databaseUrl ?? "");
  const daemons: RuntimeDaemonHandle[] = [];
  const workers: ExecutionWorkerHandle[] = [];
  const publishers: RabbitMqPublisher[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const fixtures: string[] = [];
  const queuePrefixes: string[] = [];

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M8.2 tests refuse to mutate any database except iterminal_test");
    }
    await messaging.migrate();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox, consumer_inbox RESTART IDENTITY CASCADE");
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.close().catch(() => undefined);
    for (const daemon of daemons.splice(0)) await daemon.close().catch(() => undefined);
    for (const publisher of publishers.splice(0)) await publisher.close().catch(() => undefined);
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child);
      }
    }
    for (const prefix of queuePrefixes.splice(0)) await deleteTopology(prefix);
    for (const fixture of fixtures.splice(0)) await rm(fixture, { force: true, recursive: true });
  });

  afterAll(async () => {
    await messaging.close();
    await pool.end();
  });

  it("dispatches a confirmed wake-up exactly once through the owner Runtime", async () => {
    const fixture = await createFixture("normal");
    const queuePrefix = createQueuePrefix("normal");
    const ownerId = "owner-m8-dispatch-normal";
    const daemon = await createDaemon(fixture.socketPath, ownerId);
    await createWorker(fixture.socketPath, ownerId, queuePrefix, "worker-normal");
    const publisher = await createPublisher(queuePrefix);
    const client = new UnixRuntimeClient(daemon.socketPath);
    const session = await client.createSession({ shell: "zsh", workspaceRoot: fixture.workspace });
    const admitted = await client.startExecute({
      actor: testActor,
      command: `printf 'once\\n' >> ${shellQuote(fixture.sideEffect)} && printf 'queue-ok\\n'`,
      idempotencyKey: "queue-normal",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await expect(access(fixture.sideEffect)).rejects.toThrow();
    expect(await executionStatus(admitted.execution.id)).toBe("DISPATCHING");

    const claimed = await messaging.claimBatch({
      leaseMilliseconds: 100,
      limit: 1,
      now: new Date(),
      publisherId: "publisher-lost-mark",
    });
    await publisher.publish(required(claimed[0]));
    const completed = await client.waitExecution(admitted.execution.id);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.output).toContain("queue-ok");
    await delay(125);
    const relay = new OutboxRelay("publisher-recovered", messaging, publisher, {
      retryDelay: () => 0,
    });
    expect(await relay.publishBatch()).toEqual({ claimed: 1, failed: 0, published: 1 });
    await delay(400);

    expect(await readFile(fixture.sideEffect, "utf8")).toBe("once\n");
    expect(await eventCount(session.id, "execution.write_attempted")).toBe(1);
    await client.closeSession(session.id, session.generation);
  }, 30_000);

  it("requeues safely when the Worker dies before sending dispatch RPC", async () => {
    const fixture = await createFixture("worker-crash");
    const queuePrefix = createQueuePrefix("worker-crash");
    const ownerId = "owner-m8-worker-crash";
    const consumerId = "worker-crash-recovery";
    const daemon = await createDaemon(fixture.socketPath, ownerId);
    const crashingWorker = await startCrashingWorker(
      fixture.socketPath,
      ownerId,
      queuePrefix,
      consumerId,
    );
    children.push(crashingWorker);
    const publisher = await createPublisher(queuePrefix);
    const client = new UnixRuntimeClient(daemon.socketPath);
    const session = await client.createSession({ shell: "zsh", workspaceRoot: fixture.workspace });
    const admitted = await client.startExecute({
      actor: testActor,
      command: `printf 'worker-once\\n' >> ${shellQuote(fixture.sideEffect)}`,
      idempotencyKey: "worker-crash",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    const relay = new OutboxRelay("publisher-worker-crash", messaging, publisher);
    expect(await relay.publishBatch()).toEqual({ claimed: 1, failed: 0, published: 1 });
    await waitForExit(crashingWorker);
    expect(crashingWorker.signalCode).toBe("SIGKILL");
    expect(await executionStatus(admitted.execution.id)).toBe("DISPATCHING");
    await expect(access(fixture.sideEffect)).rejects.toThrow();

    await createWorker(fixture.socketPath, ownerId, queuePrefix, consumerId, 200);
    const completed = await client.waitExecution(admitted.execution.id);
    expect(completed.status).toBe("COMPLETED");
    expect(await readFile(fixture.sideEffect, "utf8")).toBe("worker-once\n");
    expect(await eventCount(session.id, "execution.write_attempted")).toBe(1);
    await client.closeSession(session.id, session.generation);
  }, 30_000);

  it.each(["after-write", "before-finish-persist"] as const)(
    "does not replay after daemon crash at %s",
    async (failpoint) => {
      const fixture = await createFixture(failpoint);
      const queuePrefix = createQueuePrefix(failpoint);
      const ownerId = `owner-m8-${failpoint}`;
      const daemonChild = await startFailpointDaemon(fixture.socketPath, ownerId, failpoint);
      children.push(daemonChild);
      await createWorker(fixture.socketPath, ownerId, queuePrefix, `worker-${failpoint}`, 200);
      const publisher = await createPublisher(queuePrefix);
      const client = new UnixRuntimeClient(fixture.socketPath);
      const session = await client.createSession({
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      });
      const admitted = await client.startExecute({
        actor: testActor,
        command: `printf '${failpoint}\\n' >> ${shellQuote(fixture.sideEffect)}`,
        idempotencyKey: `daemon-${failpoint}`,
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      const relay = new OutboxRelay(`publisher-${failpoint}`, messaging, publisher);
      expect(await relay.publishBatch()).toEqual({ claimed: 1, failed: 0, published: 1 });
      await waitForExit(daemonChild);
      expect(daemonChild.signalCode).toBe("SIGKILL");

      const replacement = await createDaemon(fixture.socketPath, ownerId);
      expect(replacement.runtime.listSessions()).toContainEqual(
        expect.objectContaining({ id: session.id, status: "BROKEN" }),
      );
      await waitFor(async () => (await executionStatus(admitted.execution.id)) === "UNKNOWN");
      await waitFor(async () => (await inboxStatus()) === "COMPLETED");
      const contents = await readFile(fixture.sideEffect, "utf8").catch(() => "");
      const occurrences = contents.split("\n").filter((line) => line === failpoint).length;
      expect(occurrences).toBeLessThanOrEqual(1);
      if (failpoint === "before-finish-persist") expect(occurrences).toBe(1);
      expect(await eventCount(session.id, "execution.write_attempted")).toBe(1);
    },
    30_000,
  );

  async function createFixture(suffix: string): Promise<Fixture> {
    let root = await mkdtemp(join("/private/tmp", `itm8-${suffix.slice(0, 8)}-`));
    root = await realpath(root);
    fixtures.push(root);
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
    const prefix = `iterminal-m8-dispatch-${process.pid.toString()}-${suffix}-${randomUUID()}`;
    queuePrefixes.push(prefix);
    return prefix;
  }

  async function createDaemon(socketPath: string, ownerId: string): Promise<RuntimeDaemonHandle> {
    const daemon = await startRuntimeDaemon({
      databaseHealthCheckMilliseconds: 50,
      databaseReconnectInitialMilliseconds: 25,
      databaseReconnectJitterRatio: 0,
      databaseReconnectMaxMilliseconds: 25,
      databaseUrl: databaseUrl ?? "",
      executionDispatch: "external",
      ownerId,
      ownerLeaseMilliseconds: 300,
      socketPath,
    });
    await daemon.waitUntilReady();
    daemons.push(daemon);
    return daemon;
  }

  async function createWorker(
    socketPath: string,
    ownerId: string,
    queuePrefix: string,
    consumerId: string,
    inboxLeaseMilliseconds = 30_000,
  ): Promise<ExecutionWorkerHandle> {
    const worker = await startExecutionWorker({
      consumerId,
      databaseUrl: databaseUrl ?? "",
      inboxLeaseMilliseconds,
      ownerId,
      queuePrefix,
      rabbitMqUrl: rabbitMqUrl ?? "",
      runtimeSocketPath: socketPath,
    });
    await worker.waitUntilConnected();
    workers.push(worker);
    return worker;
  }

  async function createPublisher(queuePrefix: string): Promise<RabbitMqPublisher> {
    const publisher = await RabbitMqPublisher.connect(
      rabbitMqUrl ?? "",
      runtimeQueueTopology(queuePrefix),
    );
    publishers.push(publisher);
    return publisher;
  }

  async function executionStatus(executionId: string): Promise<string> {
    const result = await pool.query<{ status: string }>(
      "SELECT status FROM executions WHERE id = $1",
      [executionId],
    );
    return result.rows[0]?.status ?? "MISSING";
  }

  async function eventCount(sessionId: string, eventType: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      "SELECT count(*) FROM session_events WHERE session_id = $1 AND event_type = $2",
      [sessionId, eventType],
    );
    return Number.parseInt(result.rows[0]?.count ?? "0", 10);
  }

  async function inboxStatus(): Promise<string> {
    const result = await pool.query<{ status: string }>(
      "SELECT status FROM consumer_inbox ORDER BY first_received_at DESC LIMIT 1",
    );
    return result.rows[0]?.status ?? "MISSING";
  }
});

const testActor = {
  client: "m8-dispatch-test",
  id: "agent-m8-dispatch",
  principal: "m8-dispatch-test",
  type: "agent" as const,
};

interface Fixture {
  readonly root: string;
  readonly sideEffect: string;
  readonly socketPath: string;
  readonly workspace: string;
}

async function startCrashingWorker(
  socketPath: string,
  ownerId: string,
  queuePrefix: string,
  consumerId: string,
): Promise<ChildProcessWithoutNullStreams> {
  return startChild(
    join(repositoryRoot, "apps/execution-worker/src/fixtures/crash-before-dispatch.ts"),
    "crash-before-dispatch worker ready",
    {
      ITERM_CONSUMER_ID: consumerId,
      ITERM_DATABASE_URL: databaseUrl ?? "",
      ITERM_INBOX_LEASE_MS: "200",
      ITERM_QUEUE_PREFIX: queuePrefix,
      ITERM_RABBITMQ_URL: rabbitMqUrl ?? "",
      ITERM_RUNTIME_OWNER_ID: ownerId,
      ITERM_RUNTIME_SOCKET: socketPath,
    },
  );
}

async function startFailpointDaemon(
  socketPath: string,
  ownerId: string,
  failpoint: string,
): Promise<ChildProcessWithoutNullStreams> {
  return startChild(
    join(repositoryRoot, "apps/runtime-daemon/src/fixtures/external-dispatch-daemon.ts"),
    "external-dispatch daemon ready",
    {
      ITERM_DATABASE_URL: databaseUrl ?? "",
      ITERM_DATABASE_HEALTH_CHECK_MS: "50",
      ITERM_RUNTIME_OWNER_ID: ownerId,
      ITERM_RUNTIME_OWNER_LEASE_MS: "300",
      ITERM_RUNTIME_SOCKET: socketPath,
      ITERM_TEST_FAILPOINT: failpoint,
    },
  );
}

async function startChild(
  entrypoint: string,
  readyText: string,
  environment: Readonly<Record<string, string>>,
): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    let stderr = "";
    const timeout = setTimeout(
      () => rejectReady(new Error(`Timed out starting child: ${stderr}`)),
      10_000,
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes(readyText)) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `Child exited before ready: code=${String(code)} signal=${signal}; stderr=${stderr}`,
        ),
      );
    });
  });
  return child;
}

async function deleteTopology(prefix: string): Promise<void> {
  const topology = runtimeQueueTopology(prefix);
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

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
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
  throw new Error("Timed out waiting for M8.2 state");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value to exist");
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
