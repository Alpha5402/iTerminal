import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  startRuntimeDaemon,
  type RuntimeDaemonDurabilityState,
  type RuntimeDaemonHandle,
} from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const postgresContainer = process.env.ITERM_TEST_POSTGRES_CONTAINER;
const describeOutage =
  databaseUrl === undefined || postgresContainer === undefined ? describe.skip : describe;
const execFileAsync = promisify(execFile);

describeOutage("M8.6 PostgreSQL owner circuit and recovery", () => {
  beforeAll(async () => {
    const database = await queryDatabase<{ current_database: string }>("SELECT current_database()");
    if (database[0]?.current_database !== "iterminal_test") {
      throw new Error("M8.6 tests refuse to mutate any database except iterminal_test");
    }
    const durability = new PostgresRuntimeDurability(databaseUrl ?? "");
    try {
      await durability.migrate();
    } finally {
      await durability.close();
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

  it("breaks every owner Session and reconciles durable truth before admitting a replacement", async () => {
    const fixture = await createFixture("running");
    const states: RuntimeDaemonDurabilityState[] = [];
    const ownerId = "owner-m8-postgres-running-outage";
    let daemon: RuntimeDaemonHandle | undefined;
    let databaseStopped = false;
    try {
      daemon = await startRuntimeDaemon({
        databaseHealthCheckMilliseconds: 100,
        databaseReconnectInitialMilliseconds: 100,
        databaseReconnectJitterRatio: 0,
        databaseReconnectMaxMilliseconds: 500,
        databaseStatementTimeoutMilliseconds: 1_000,
        databaseUrl: databaseUrl ?? "",
        ownerId,
        onDurabilityState: (state) => states.push(state),
        socketPath: fixture.socketPath,
      });
      expect(daemon.durabilityState().phase).toBe("READY");
      const client = new UnixRuntimeClient(fixture.socketPath);
      const left = await client.createSession({ shell: "zsh", workspaceRoot: fixture.workspace });
      const right = await client.createSession({ shell: "zsh", workspaceRoot: fixture.workspace });
      const running = await client.startExecute({
        actor,
        command: "python3 -q",
        idempotencyKey: "database-outage-running-execution",
        sessionGeneration: left.generation,
        sessionId: left.id,
      });
      await waitFor(
        async () => (await client.getExecution(running.execution.id)).status === "RUNNING",
      );
      const shellPids = await queryDatabase<{ shell_pid: number }>(
        `SELECT shell_pid FROM session_generations
          WHERE owner_id = $1 AND status IN ('READY', 'RUNNING')
          ORDER BY session_id`,
        [ownerId],
      );
      expect(shellPids).toHaveLength(2);

      await stopContainer(postgresContainer ?? "");
      databaseStopped = true;
      await waitFor(() => Promise.resolve(!daemon?.runtime.isDurabilityHealthy()));
      await expect(
        client.sendInput({
          actor,
          data: `open(${JSON.stringify(fixture.sideEffect)}, 'w').write('must-not-run\\n')\n`,
          idempotencyKey: "database-outage-input",
          sessionGeneration: left.generation,
          sessionId: left.id,
          targetExecutionId: running.execution.id,
        }),
      ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", retryable: true });

      await waitFor(() =>
        Promise.resolve(
          daemon?.runtime.getSession(left.id).status === "BROKEN" &&
            daemon.runtime.getSession(right.id).status === "BROKEN" &&
            !daemon.runtime.isDurabilityHealthy(),
        ),
      );
      await expect(access(fixture.sideEffect)).rejects.toThrow();
      await expect(
        client.createSession({ shell: "zsh", workspaceRoot: fixture.workspace }),
      ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", retryable: true });
      for (const row of shellPids) await waitUntilProcessGone(row.shell_pid);

      await startContainer(postgresContainer ?? "");
      databaseStopped = false;
      await waitForPostgres();
      await withTimeout(daemon.waitUntilReady(), 30_000, "Runtime PostgreSQL recovery");
      expect(daemon.durabilityState().phase).toBe("READY");
      expect(daemon.runtime.isDurabilityHealthy()).toBe(true);
      expect(states.some((state) => state.phase === "UNAVAILABLE")).toBe(true);

      const reconciled = await queryDatabase<{
        broken_events: string;
        execution_status: string | null;
        generation_status: string;
        session_status: string;
      }>(
        `SELECT s.status AS session_status,
                g.status AS generation_status,
                e.status AS execution_status,
                (SELECT count(*) FROM session_events e
                  WHERE e.session_id = s.id AND e.event_type = 'session.broken') AS broken_events
           FROM sessions s
           JOIN session_generations g
             ON g.session_id = s.id AND g.generation = s.current_generation
           LEFT JOIN executions e ON e.session_id = s.id
          WHERE s.id IN ($1, $2)
          ORDER BY s.id`,
        [left.id, right.id],
      );
      expect(reconciled).toHaveLength(2);
      expect(
        reconciled.every(
          (row) =>
            row.session_status === "BROKEN" &&
            row.generation_status === "BROKEN" &&
            Number.parseInt(row.broken_events, 10) >= 1,
        ),
      ).toBe(true);
      expect(reconciled.find((row) => row.execution_status !== null)?.execution_status).toBe(
        "UNKNOWN",
      );
      const rejectedActions = await queryDatabase<{ count: string }>(
        "SELECT count(*) FROM actions WHERE idempotency_key = 'database-outage-input'",
      );
      expect(rejectedActions[0]?.count).toBe("0");

      const replacement = await client.createSession({
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      });
      const executed = await client.startExecute({
        actor,
        command: `printf 'recovered\\n' >> ${shellQuote(fixture.sideEffect)}`,
        idempotencyKey: "database-recovered-command",
        sessionGeneration: replacement.generation,
        sessionId: replacement.id,
      });
      const completed = await withTimeout(
        client.waitExecution(executed.execution.id),
        20_000,
        "replacement Session execution",
      );
      expect(completed.status).toBe("COMPLETED");
      expect(await readFile(fixture.sideEffect, "utf8")).toBe("recovered\n");
      await client.closeSession(replacement.id, replacement.generation);

      await daemon.close();
      daemon = undefined;
      const preserved = await queryDatabase<{ status: string }>(
        "SELECT status FROM sessions WHERE id IN ($1, $2) ORDER BY id",
        [left.id, right.id],
      );
      expect(preserved.map((row) => row.status)).toEqual(["BROKEN", "BROKEN"]);
    } finally {
      if (databaseStopped) await ensureContainerStarted(postgresContainer ?? "");
      await daemon?.close().catch(() => undefined);
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 90_000);

  it("starts degraded without PostgreSQL and becomes ready without a daemon restart", async () => {
    const fixture = await createFixture("cold");
    const states: RuntimeDaemonDurabilityState[] = [];
    let daemon: RuntimeDaemonHandle | undefined;
    let databaseStopped = false;
    try {
      await stopContainer(postgresContainer ?? "");
      databaseStopped = true;
      daemon = await startRuntimeDaemon({
        databaseHealthCheckMilliseconds: 100,
        databaseReconnectInitialMilliseconds: 100,
        databaseReconnectJitterRatio: 0,
        databaseReconnectMaxMilliseconds: 500,
        databaseStatementTimeoutMilliseconds: 500,
        databaseUrl: databaseUrl ?? "",
        ownerId: "owner-m8-postgres-cold-outage",
        onDurabilityState: (state) => states.push(state),
        socketPath: fixture.socketPath,
      });
      expect(daemon.durabilityState().phase).not.toBe("READY");
      const client = new UnixRuntimeClient(fixture.socketPath);
      await expect(
        client.createSession({ shell: "zsh", workspaceRoot: fixture.workspace }),
      ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", retryable: true });
      expect(daemon.runtime.listSessions()).toEqual([]);

      await startContainer(postgresContainer ?? "");
      databaseStopped = false;
      await waitForPostgres();
      await withTimeout(daemon.waitUntilReady(), 30_000, "cold-start PostgreSQL recovery");
      const session = await client.createSession({
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      });
      const executed = await client.startExecute({
        actor,
        command: `printf 'cold-recovered\\n' >> ${shellQuote(fixture.sideEffect)}`,
        idempotencyKey: "cold-database-recovered-command",
        sessionGeneration: session.generation,
        sessionId: session.id,
      });
      expect(
        await withTimeout(
          client.waitExecution(executed.execution.id),
          20_000,
          "cold-start recovered execution",
        ),
      ).toMatchObject({ status: "COMPLETED" });
      expect(await readFile(fixture.sideEffect, "utf8")).toBe("cold-recovered\n");
      expect(states.some((state) => state.phase === "UNAVAILABLE")).toBe(true);
      expect(states.some((state) => state.phase === "READY")).toBe(true);
      await client.closeSession(session.id, session.generation);
    } finally {
      if (databaseStopped) await ensureContainerStarted(postgresContainer ?? "");
      await daemon?.close().catch(() => undefined);
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 90_000);
});

const actor = {
  client: "m8-postgres-outage-test",
  id: "agent-m8-postgres-outage",
  principal: "m8-postgres-outage-test",
  type: "agent" as const,
};

async function createFixture(suffix: string): Promise<{
  readonly root: string;
  readonly sideEffect: string;
  readonly socketPath: string;
  readonly workspace: string;
}> {
  let root = await mkdtemp(join("/private/tmp", `itm8-postgres-${suffix}-`));
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

async function queryDatabase<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2_000,
    max: 1,
  });
  try {
    const result = await pool.query<T>(text, [...values]);
    return result.rows;
  } finally {
    await pool.end().catch(() => undefined);
  }
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

async function waitUntilProcessGone(pid: number): Promise<void> {
  await waitFor(() => Promise.resolve(!isProcessAlive(pid)), 15_000);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
