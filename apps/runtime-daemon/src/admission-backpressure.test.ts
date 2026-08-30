import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { OutboxRelay } from "@iterminal/messaging";
import {
  PostgresMessagingRepository,
  PostgresRuntimeDurability,
} from "@iterminal/persistence-postgres";
import { RabbitMqPublisher, runtimeQueueTopology } from "@iterminal/queue-rabbitmq";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import amqp from "amqplib";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const rabbitMqUrl = process.env.ITERM_RABBITMQ_URL;
const describeAdmission =
  databaseUrl === undefined || rabbitMqUrl === undefined ? describe.skip : describe;
const repositoryRoot = resolve(import.meta.dirname, "../../..");

describeAdmission("M8.4 admission outage and Outbox backpressure", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const children: ChildProcessWithoutNullStreams[] = [];
  const daemons: RuntimeDaemonHandle[] = [];
  const fixtures: string[] = [];
  const publishers: RabbitMqPublisher[] = [];
  const messagingRepositories: PostgresMessagingRepository[] = [];
  const queuePrefixes: string[] = [];

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M8.4 tests refuse to mutate any database except iterminal_test");
    }
    const durability = new PostgresRuntimeDurability(databaseUrl ?? "");
    await durability.migrate();
    await durability.close();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox, consumer_inbox RESTART IDENTITY CASCADE");
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child);
      }
    }
    for (const daemon of daemons.splice(0)) await daemon.close().catch(() => undefined);
    for (const publisher of publishers.splice(0)) await publisher.close().catch(() => undefined);
    for (const repository of messagingRepositories.splice(0)) {
      await repository.close().catch(() => undefined);
    }
    for (const prefix of queuePrefixes.splice(0)) await deleteTopology(prefix);
    for (const fixture of fixtures.splice(0)) await rm(fixture, { force: true, recursive: true });
  });

  afterAll(async () => pool.end());

  it("rolls back every admission fact when the Runtime dies before PostgreSQL commit", async () => {
    const fixture = await createFixture("precommit");
    const ownerId = "owner-m8-precommit-crash";
    const child = await startPrecommitCrashDaemon(fixture.socketPath, ownerId);
    children.push(child);
    const client = new UnixRuntimeClient(fixture.socketPath);
    const session = await client.createSession({ shell: "zsh", workspaceRoot: fixture.workspace });

    await client
      .startExecute({
        actor,
        command: `printf 'must-not-run\\n' >> ${shellQuote(fixture.sideEffect)}`,
        idempotencyKey: "precommit-crash",
        sessionGeneration: session.generation,
        sessionId: session.id,
      })
      .catch(() => undefined);
    await waitForExit(child);
    expect(child.signalCode).toBe("SIGKILL");

    const replacement = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId,
      socketPath: fixture.socketPath,
    });
    daemons.push(replacement);
    expect(replacement.runtime.listSessions()).toEqual([]);
    expect(await admissionCounts(session.id)).toMatchObject({
      accepted_events: "0",
      actions: "0",
      executions: "0",
      outbox: "0",
      session_status: "BROKEN",
    });
    await expect(access(fixture.sideEffect)).rejects.toThrow();
  }, 30_000);

  it("rejects new admission without breaking READY when pending Outbox capacity is full", async () => {
    const fixture = await createFixture("backpressure");
    const ownerId = "owner-m8-outbox-backpressure";
    const daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      executionDispatch: "external",
      outboxMaxPending: 1,
      ownerId,
      socketPath: fixture.socketPath,
    });
    daemons.push(daemon);
    const client = new UnixRuntimeClient(fixture.socketPath);
    const first = await client.createSession({ shell: "zsh", workspaceRoot: fixture.workspace });
    const second = await client.createSession({ shell: "zsh", workspaceRoot: fixture.workspace });
    await client.startExecute({
      actor,
      command: `printf 'first\\n' >> ${shellQuote(fixture.sideEffect)}`,
      idempotencyKey: "backpressure-first",
      sessionGeneration: first.generation,
      sessionId: first.id,
    });

    const secondRequest = {
      actor,
      command: `printf 'second\\n' >> ${shellQuote(fixture.sideEffect)}`,
      idempotencyKey: "backpressure-second",
      sessionGeneration: second.generation,
      sessionId: second.id,
    };
    await expect(client.startExecute(secondRequest)).rejects.toMatchObject({
      code: "BACKPRESSURE",
      details: { maxPendingOutbox: 1, pendingOutbox: 1 },
      retryable: true,
    });
    expect(daemon.runtime.getSession(second.id).status).toBe("READY");
    expect(await sessionActionCount(second.id)).toBe(0);
    await expect(access(fixture.sideEffect)).rejects.toThrow();

    const queuePrefix = `iterminal-m8-backpressure-${process.pid.toString()}-${randomUUID()}`;
    queuePrefixes.push(queuePrefix);
    const publisher = await RabbitMqPublisher.connect(
      rabbitMqUrl ?? "",
      runtimeQueueTopology(queuePrefix),
    );
    publishers.push(publisher);
    const messaging = new PostgresMessagingRepository(databaseUrl ?? "");
    messagingRepositories.push(messaging);
    const relay = new OutboxRelay("publisher-backpressure-recovery", messaging, publisher);
    expect(await relay.publishBatch()).toEqual({ claimed: 1, failed: 0, published: 1 });

    const admitted = await client.startExecute(secondRequest);
    expect(admitted.execution.status).toBe("DISPATCHING");
    expect(daemon.runtime.getSession(second.id).status).toBe("RESERVED");
    expect(await sessionActionCount(second.id)).toBe(1);
    await expect(access(fixture.sideEffect)).rejects.toThrow();
  }, 30_000);

  it("admits at most the configured Outbox capacity across concurrent Sessions", async () => {
    const fixture = await createFixture("concurrent");
    const capacity = 3;
    const daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      executionDispatch: "external",
      outboxMaxPending: capacity,
      ownerId: "owner-m8-concurrent-backpressure",
      socketPath: fixture.socketPath,
    });
    daemons.push(daemon);
    const client = new UnixRuntimeClient(fixture.socketPath);
    const sessions = await Promise.all(
      Array.from({ length: 10 }, () =>
        client.createSession({ shell: "zsh", workspaceRoot: fixture.workspace }),
      ),
    );

    const results = await Promise.allSettled(
      sessions.map((session, index) =>
        client.startExecute({
          actor,
          command: `printf '${index.toString()}\\n' >> ${shellQuote(fixture.sideEffect)}`,
          idempotencyKey: `concurrent-${index.toString()}`,
          sessionGeneration: session.generation,
          sessionId: session.id,
        }),
      ),
    );
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(capacity);
    expect(rejected).toHaveLength(sessions.length - capacity);
    expect(
      rejected.every(
        (result) =>
          result.status === "rejected" &&
          isRecord(result.reason) &&
          result.reason.code === "BACKPRESSURE",
      ),
    ).toBe(true);
    const pending = await pool.query<{ count: string }>(
      "SELECT count(*) FROM outbox WHERE published_at IS NULL",
    );
    expect(pending.rows[0]?.count).toBe(capacity.toString());
    expect(
      daemon.runtime.listSessions().filter((session) => session.status === "RESERVED"),
    ).toHaveLength(capacity);
    expect(
      daemon.runtime.listSessions().filter((session) => session.status === "READY"),
    ).toHaveLength(sessions.length - capacity);
    await expect(access(fixture.sideEffect)).rejects.toThrow();
  }, 30_000);

  it("times out a blocked admission without writing the Shell", async () => {
    const fixture = await createFixture("db-stall");
    const ownerId = "owner-m8-db-stall";
    const daemon = await startRuntimeDaemon({
      databaseStatementTimeoutMilliseconds: 200,
      databaseUrl: databaseUrl ?? "",
      executionDispatch: "external",
      ownerId,
      socketPath: fixture.socketPath,
    });
    daemons.push(daemon);
    const client = new UnixRuntimeClient(fixture.socketPath);
    const session = await client.createSession({ shell: "zsh", workspaceRoot: fixture.workspace });
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [session.id]);
      await expect(
        client.startExecute({
          actor,
          command: `printf 'db-stall-must-not-run\\n' >> ${shellQuote(fixture.sideEffect)}`,
          idempotencyKey: "db-stall",
          sessionGeneration: session.generation,
          sessionId: session.id,
        }),
      ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", retryable: true });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    expect(daemon.runtime.getSession(session.id).status).toBe("BROKEN");
    expect(await sessionActionCount(session.id)).toBe(0);
    await expect(access(fixture.sideEffect)).rejects.toThrow();

    await daemon.close().catch(() => undefined);
    daemons.splice(daemons.indexOf(daemon), 1);
    const replacement = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId,
      socketPath: fixture.socketPath,
    });
    daemons.push(replacement);
    expect((await admissionCounts(session.id)).session_status).toBe("BROKEN");
  }, 30_000);

  async function createFixture(suffix: string): Promise<Fixture> {
    let root = await mkdtemp(join("/private/tmp", `ita-${suffix.slice(0, 4)}-`));
    root = await realpath(root);
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    return {
      sideEffect: join(root, "side-effect.txt"),
      socketPath: join(root, "runtime.sock"),
      workspace,
    };
  }

  async function admissionCounts(sessionId: string): Promise<AdmissionCounts> {
    const result = await pool.query<AdmissionCounts>(
      `SELECT s.status AS session_status,
              (SELECT count(*) FROM actions a WHERE a.session_id = s.id) AS actions,
              (SELECT count(*) FROM executions e WHERE e.session_id = s.id) AS executions,
              (SELECT count(*) FROM outbox o WHERE o.aggregate_id = s.id) AS outbox,
              (SELECT count(*) FROM session_events v
                WHERE v.session_id = s.id AND v.event_type = 'action.accepted') AS accepted_events
         FROM sessions s WHERE s.id = $1`,
      [sessionId],
    );
    const counts = result.rows[0];
    if (counts === undefined) throw new Error(`Missing Session ${sessionId}`);
    return counts;
  }

  async function sessionActionCount(sessionId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      "SELECT count(*) FROM actions WHERE session_id = $1",
      [sessionId],
    );
    return Number.parseInt(result.rows[0]?.count ?? "0", 10);
  }
});

const actor = {
  client: "m8-admission-test",
  id: "agent-m8-admission",
  principal: "m8-admission-test",
  type: "agent" as const,
};

interface AdmissionCounts {
  readonly accepted_events: string;
  readonly actions: string;
  readonly executions: string;
  readonly outbox: string;
  readonly session_status: string;
}

interface Fixture {
  readonly sideEffect: string;
  readonly socketPath: string;
  readonly workspace: string;
}

async function startPrecommitCrashDaemon(
  socketPath: string,
  ownerId: string,
): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(repositoryRoot, "apps/runtime-daemon/src/fixtures/precommit-crash-daemon.ts"),
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ITERM_DATABASE_URL: databaseUrl ?? "",
        ITERM_RUNTIME_OWNER_ID: ownerId,
        ITERM_RUNTIME_SOCKET: socketPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  await new Promise<void>((resolveReady, rejectReady) => {
    let stderr = "";
    const timeout = setTimeout(
      () => rejectReady(new Error(`Timed out starting precommit daemon: ${stderr}`)),
      10_000,
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes("precommit-crash daemon ready")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `Precommit daemon exited before ready: code=${String(code)} signal=${signal}; stderr=${stderr}`,
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
