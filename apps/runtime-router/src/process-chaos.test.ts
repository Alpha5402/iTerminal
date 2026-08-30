import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Session } from "@iterminal/domain";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const repositoryRoot = resolve(import.meta.dirname, "../../..");

interface ManagedChild {
  readonly label: string;
  readonly process: ChildProcessWithoutNullStreams;
  stderr: string;
}

describeDatabase("M9.5 independent-process multi-owner chaos", () => {
  const children: ManagedChild[] = [];
  const fixtures: string[] = [];
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M9.5 tests refuse to mutate any database except iterminal_test");
    }
    const migrator = new PostgresRuntimeDurability(databaseUrl ?? "");
    await migrator.migrate();
    await migrator.close();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE runtime_workers, sessions, actors, outbox RESTART IDENTITY CASCADE");
  });

  afterEach(async () => {
    for (const child of children.reverse()) await stopChild(child, "SIGTERM");
    children.length = 0;
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  afterAll(async () => pool.end());

  it("survives Router restart, Runtime SIGKILL replacement, and graceful owner drain without PTY takeover", async () => {
    const root = await realpath(await mkdtemp(join("/private/tmp", "itr-m95-chaos-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const ownerSockets = {
      "owner-chaos-a": join(root, "a.sock"),
      "owner-chaos-b": join(root, "b.sock"),
      "owner-chaos-c": join(root, "c.sock"),
    } as const;
    const owners = await Promise.all(
      Object.entries(ownerSockets).map(([ownerId, socketPath]) =>
        startRuntimeChild(root, ownerId, `instance-${ownerId}-1`, socketPath),
      ),
    );
    children.push(...owners);
    const routerSocket = join(root, "router.sock");
    let router = await startRouterChild(routerSocket);
    children.push(router);
    let client = new UnixRuntimeClient(routerSocket);

    const firstWave = await Promise.all(
      Array.from({ length: 12 }, () =>
        client.createSession({ shell: "zsh", workspaceRoot: workspace }),
      ),
    );
    expect(ownerCounts(firstWave)).toEqual({
      "owner-chaos-a": 4,
      "owner-chaos-b": 4,
      "owner-chaos-c": 4,
    });

    router.process.kill("SIGKILL");
    await waitForExit(router);
    expect(router.process.signalCode).toBe("SIGKILL");
    router = await startRouterChild(routerSocket);
    children.push(router);
    client = new UnixRuntimeClient(routerSocket);
    const victimSession = requiredSession(
      firstWave.filter((session) => session.ownerId === "owner-chaos-b"),
      0,
    );
    expect((await client.getSession(victimSession.id)).id).toBe(victimSession.id);

    const sleeping = await client.startExecute({
      actor: actor("chaos-victim"),
      command: "sleep 30",
      idempotencyKey: "m95-victim-sleep",
      sessionGeneration: victimSession.generation,
      sessionId: victimSession.id,
    });
    await waitForExecutionStatus(client, sleeping.execution.id, "RUNNING");
    const shell = await pool.query<{ shell_pid: number }>(
      `SELECT generation.shell_pid
         FROM session_generations AS generation
        WHERE generation.session_id = $1 AND generation.generation = $2`,
      [victimSession.id, victimSession.generation],
    );
    const shellPid = shell.rows[0]?.shell_pid;
    if (shellPid === undefined) throw new Error("Victim Shell PID is missing");

    const victimOwner = requiredChild(owners, "runtime-owner-chaos-b");
    victimOwner.process.kill("SIGKILL");
    await waitForExit(victimOwner);
    expect(victimOwner.process.signalCode).toBe("SIGKILL");
    await waitUntilProcessGone(shellPid);
    await expect(client.getSession(victimSession.id)).rejects.toMatchObject({
      code: "OWNER_ROUTE_UNAVAILABLE",
      retryable: true,
    });

    const replacement = await startRuntimeChild(
      root,
      "owner-chaos-b",
      "instance-owner-chaos-b-2",
      ownerSockets["owner-chaos-b"],
    );
    children.push(replacement);
    const recoveredSession = await waitForSessionStatus(client, victimSession.id, "BROKEN", 10_000);
    expect(recoveredSession.generation).toBe(victimSession.generation);
    await expect(client.getExecution(sleeping.execution.id)).rejects.toMatchObject({
      code: "EXECUTION_NOT_FOUND",
    });
    const recoveredExecution = await pool.query<{ status: string; unknown_reason: string }>(
      "SELECT status, unknown_reason FROM executions WHERE id = $1",
      [sleeping.execution.id],
    );
    expect(recoveredExecution.rows).toEqual([
      {
        status: "UNKNOWN",
        unknown_reason: "runtime owner restarted without a graceful close",
      },
    ]);
    const replacementOwner = await pool.query<{
      instance_id: string;
      registry_epoch: string;
      status: string;
    }>(
      `SELECT instance_id, registry_epoch::text, status
         FROM runtime_workers
        WHERE owner_id = 'owner-chaos-b'`,
    );
    expect(replacementOwner.rows).toEqual([
      {
        instance_id: "instance-owner-chaos-b-2",
        registry_epoch: "2",
        status: "ACTIVE",
      },
    ]);

    const replacementWave = await Promise.all(
      Array.from({ length: 3 }, () =>
        client.createSession({ shell: "zsh", workspaceRoot: workspace }),
      ),
    );
    expect(ownerCounts(replacementWave)).toEqual({
      "owner-chaos-a": 1,
      "owner-chaos-b": 1,
      "owner-chaos-c": 1,
    });
    const replacementSession = requiredSession(
      replacementWave.filter((session) => session.ownerId === "owner-chaos-b"),
      0,
    );
    expect(replacementSession.id).not.toBe(victimSession.id);
    const replacementExecution = await client.startExecute({
      actor: actor("chaos-replacement"),
      command: "printf m95-replacement",
      idempotencyKey: "m95-replacement-execute",
      sessionGeneration: replacementSession.generation,
      sessionId: replacementSession.id,
    });
    expect((await client.waitExecution(replacementExecution.execution.id)).status).toBe(
      "COMPLETED",
    );
    expect((await client.getSession(victimSession.id)).status).toBe("BROKEN");

    const gracefulOwner = requiredChild(owners, "runtime-owner-chaos-c");
    const stoppedSession = requiredSession(
      firstWave.filter((session) => session.ownerId === "owner-chaos-c"),
      0,
    );
    gracefulOwner.process.kill("SIGTERM");
    await waitForExit(gracefulOwner, 15_000);
    expect(gracefulOwner.process.exitCode).toBe(0);
    await waitForOwnerStatus("owner-chaos-c", "STOPPED");
    const stoppedOwnerSessions = await pool.query<{ session_count: string; status: string }>(
      `SELECT status, count(*)::text AS session_count
         FROM sessions
        WHERE owner_id = 'owner-chaos-c'
        GROUP BY status`,
    );
    expect(stoppedOwnerSessions.rows).toEqual([{ session_count: "5", status: "CLOSED" }]);
    const stoppedOwnerLeases = await pool.query(
      `SELECT 1
         FROM session_leases AS lease
         JOIN sessions AS session ON session.id = lease.session_id
        WHERE session.owner_id = 'owner-chaos-c' AND lease.released_at IS NULL`,
    );
    expect(stoppedOwnerLeases.rowCount).toBe(0);
    await expect(client.getSession(stoppedSession.id)).rejects.toMatchObject({
      code: "OWNER_ROUTE_UNAVAILABLE",
      retryable: true,
    });
    const afterDrain = await Promise.all(
      Array.from({ length: 4 }, () =>
        client.createSession({ shell: "zsh", workspaceRoot: workspace }),
      ),
    );
    expect(ownerCounts(afterDrain)).toEqual({ "owner-chaos-a": 2, "owner-chaos-b": 2 });

    const liveIds = [replacementSession.id, ...afterDrain.map((session) => session.id)];
    const invalidLeases = await pool.query(
      `SELECT session.id
         FROM sessions AS session
         LEFT JOIN session_leases AS lease
           ON lease.session_id = session.id
          AND lease.session_generation = session.current_generation
          AND lease.released_at IS NULL
        WHERE session.id = ANY($1::text[])
        GROUP BY session.id
       HAVING count(lease.session_id) <> 1`,
      [liveIds],
    );
    expect(invalidLeases.rowCount).toBe(0);
    const victimLease = await pool.query<{ released_at: Date | null }>(
      `SELECT released_at
         FROM session_leases
        WHERE session_id = $1 AND session_generation = $2`,
      [victimSession.id, victimSession.generation],
    );
    expect(victimLease.rows[0]?.released_at).toBeInstanceOf(Date);
  }, 120_000);

  async function startRuntimeChild(
    root: string,
    ownerId: string,
    instanceId: string,
    socketPath: string,
  ): Promise<ManagedChild> {
    const child = startChild(`runtime-${ownerId}`, "apps/runtime-daemon/src/main.ts", {
      ITERM_DATABASE_HEALTH_CHECK_MS: "100",
      ITERM_DATABASE_RECONNECT_INITIAL_MS: "50",
      ITERM_DATABASE_RECONNECT_MAX_MS: "50",
      ITERM_DATABASE_URL: databaseUrl ?? "",
      ITERM_RUNTIME_OWNER_ID: ownerId,
      ITERM_RUNTIME_OWNER_INSTANCE_ID: instanceId,
      ITERM_RUNTIME_OWNER_LEASE_MS: "2000",
      ITERM_RUNTIME_SOCKET: socketPath,
      ITERM_SESSION_LEASE_MS: "2000",
      TMPDIR: root,
    });
    await waitForText(child, "Runtime daemon listening", 15_000);
    await waitForText(child, "Runtime PostgreSQL ready", 15_000);
    return child;
  }

  async function startRouterChild(socketPath: string): Promise<ManagedChild> {
    const child = startChild("router", "apps/runtime-router/src/main.ts", {
      ITERM_DATABASE_URL: databaseUrl ?? "",
      ITERM_ROUTER_SOCKET: socketPath,
    });
    await waitForText(child, "Runtime Router listening", 15_000);
    return child;
  }

  function startChild(
    label: string,
    entrypoint: string,
    environment: Readonly<Record<string, string>>,
  ): ManagedChild {
    const child = spawn(process.execPath, ["--import", "tsx", join(repositoryRoot, entrypoint)], {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const managed: ManagedChild = { label, process: child, stderr: "" };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      managed.stderr += chunk;
    });
    return managed;
  }

  async function waitForOwnerStatus(ownerId: string, status: string): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const result = await pool.query<{ status: string }>(
        "SELECT status FROM runtime_workers WHERE owner_id = $1",
        [ownerId],
      );
      if (result.rows[0]?.status === status) return;
      await delay(20);
    }
    throw new Error(`Owner ${ownerId} did not reach ${status}`);
  }
});

function actor(id: string) {
  return {
    client: "m9-process-chaos-test",
    id,
    principal: id,
    type: "agent" as const,
  };
}

function ownerCounts(sessions: readonly Session[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const session of sessions) {
    counts[session.ownerId] = (counts[session.ownerId] ?? 0) + 1;
  }
  return counts;
}

function requiredSession(sessions: readonly Session[], index: number): Session {
  const session = sessions[index];
  if (session === undefined) throw new Error(`Session ${index.toString()} is missing`);
  return session;
}

function requiredChild(children: readonly ManagedChild[], label: string): ManagedChild {
  const child = children.find((candidate) => candidate.label === label);
  if (child === undefined) throw new Error(`Child is missing: ${label}`);
  return child;
}

async function waitForExecutionStatus(
  client: UnixRuntimeClient,
  executionId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await client.getExecution(executionId)).status === status) return;
    await delay(20);
  }
  throw new Error(`Execution ${executionId} did not reach ${status}`);
}

async function waitForSessionStatus(
  client: UnixRuntimeClient,
  sessionId: string,
  status: string,
  timeoutMilliseconds: number,
): Promise<Session> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMilliseconds) {
    try {
      const session = await client.getSession(sessionId);
      if (session.status === status) return session;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(
    `Session ${sessionId} did not reach ${status}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function waitForText(
  child: ManagedChild,
  expected: string,
  timeoutMilliseconds: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMilliseconds) {
    if (child.stderr.includes(expected)) return;
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      throw new Error(`${child.label} exited before ${expected}: ${child.stderr}`);
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${child.label} text ${expected}: ${child.stderr}`);
}

async function waitForExit(child: ManagedChild, timeoutMilliseconds = 10_000): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  await new Promise<void>((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      rejectExit(new Error(`Timed out waiting for ${child.label} exit: ${child.stderr}`));
    }, timeoutMilliseconds);
    child.process.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

async function stopChild(child: ManagedChild, signal: NodeJS.Signals): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  child.process.kill(signal);
  try {
    await waitForExit(child, 10_000);
  } catch {
    child.process.kill("SIGKILL");
    await waitForExit(child, 5_000);
  }
}

async function waitUntilProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isNodeError(error, "ESRCH")) return;
      throw error;
    }
    await delay(10);
  }
  throw new Error(`Shell process survived Runtime SIGKILL: ${pid.toString()}`);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
