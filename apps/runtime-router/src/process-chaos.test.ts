import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Session } from "@iterminal/domain";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { startTcpFaultProxy, type TcpFaultProxy } from "@iterminal/testkit";
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

describeDatabase("M9 independent-process multi-owner chaos", () => {
  const children: ManagedChild[] = [];
  const fixtures: string[] = [];
  const pool = new Pool({ connectionString: databaseUrl });
  const proxies: TcpFaultProxy[] = [];

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M9 process tests refuse to mutate any database except iterminal_test");
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
    for (const proxy of proxies.splice(0)) await proxy.close().catch(() => undefined);
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

  it("isolates one owner's PostgreSQL blackhole while healthy owners keep routing and placement", async () => {
    const root = await realpath(await mkdtemp(join("/private/tmp", "itr-m96-part-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const proxy = await proxyFor(databaseUrl ?? "");
    proxies.push(proxy);
    const victimDatabaseUrl = throughProxy(databaseUrl ?? "", proxy);
    const owners = await Promise.all([
      startRuntimeChild(root, "owner-partition-a", "instance-partition-a", join(root, "a.sock")),
      startRuntimeChild(
        root,
        "owner-partition-b",
        "instance-partition-b",
        join(root, "b.sock"),
        victimDatabaseUrl,
      ),
      startRuntimeChild(root, "owner-partition-c", "instance-partition-c", join(root, "c.sock")),
    ]);
    children.push(...owners);
    const routerSocket = join(root, "router.sock");
    children.push(await startRouterChild(routerSocket));
    const client = new UnixRuntimeClient(routerSocket);
    const firstWave = await Promise.all(
      Array.from({ length: 6 }, () =>
        client.createSession({ shell: "zsh", workspaceRoot: workspace }),
      ),
    );
    expect(ownerCounts(firstWave)).toEqual({
      "owner-partition-a": 2,
      "owner-partition-b": 2,
      "owner-partition-c": 2,
    });
    const victimSession = requiredSession(
      firstWave.filter((session) => session.ownerId === "owner-partition-b"),
      0,
    );
    const healthySession = requiredSession(
      firstWave.filter((session) => session.ownerId === "owner-partition-a"),
      0,
    );
    const sleeping = await client.startExecute({
      actor: actor("partition-victim"),
      command: "sleep 30",
      idempotencyKey: "m96-victim-sleep",
      sessionGeneration: victimSession.generation,
      sessionId: victimSession.id,
    });
    await waitForExecutionStatus(client, sleeping.execution.id, "RUNNING");
    const shell = await pool.query<{ shell_pid: number }>(
      `SELECT shell_pid FROM session_generations
        WHERE session_id = $1 AND generation = $2`,
      [victimSession.id, victimSession.generation],
    );
    const shellPid = shell.rows[0]?.shell_pid;
    if (shellPid === undefined) throw new Error("Partition victim Shell PID is missing");
    const victimOwner = requiredChild(owners, "runtime-owner-partition-b");
    const initialReadyCount = occurrenceCount(victimOwner.stderr, "Runtime PostgreSQL ready");

    proxy.setMode("BLACKHOLE");
    await waitForText(victimOwner, "Runtime PostgreSQL unavailable", 10_000);
    await waitUntilProcessGone(shellPid);
    await waitForOwnerExpiry("owner-partition-b", 10_000);
    await expect(client.getSession(victimSession.id)).rejects.toMatchObject({
      code: "OWNER_ROUTE_UNAVAILABLE",
      retryable: true,
    });

    const healthyExecution = await client.startExecute({
      actor: actor("partition-healthy"),
      command: "printf m96-healthy",
      idempotencyKey: "m96-healthy-execute",
      sessionGeneration: healthySession.generation,
      sessionId: healthySession.id,
    });
    expect((await client.waitExecution(healthyExecution.execution.id)).status).toBe("COMPLETED");
    const duringPartition = await Promise.all(
      Array.from({ length: 4 }, () =>
        client.createSession({ shell: "zsh", workspaceRoot: workspace }),
      ),
    );
    expect(ownerCounts(duringPartition)).toEqual({
      "owner-partition-a": 2,
      "owner-partition-c": 2,
    });

    proxy.setMode("CUT");
    proxy.setMode("FORWARD");
    await waitForOccurrence(victimOwner, "Runtime PostgreSQL ready", initialReadyCount + 1, 20_000);
    const recovered = await waitForSessionStatus(client, victimSession.id, "BROKEN", 15_000);
    expect(recovered.status).toBe("BROKEN");
    const durableExecution = await pool.query<{ status: string }>(
      "SELECT status FROM executions WHERE id = $1",
      [sleeping.execution.id],
    );
    expect(durableExecution.rows).toEqual([{ status: "UNKNOWN" }]);
    const owner = await pool.query<{ instance_id: string; registry_epoch: string }>(
      `SELECT instance_id, registry_epoch::text
         FROM runtime_workers WHERE owner_id = 'owner-partition-b'`,
    );
    expect(owner.rows).toEqual([{ instance_id: "instance-partition-b", registry_epoch: "1" }]);

    const afterRecovery = await Promise.all(
      Array.from({ length: 3 }, () =>
        client.createSession({ shell: "zsh", workspaceRoot: workspace }),
      ),
    );
    const replacementSession = requiredSession(
      afterRecovery.filter((session) => session.ownerId === "owner-partition-b"),
      0,
    );
    expect(replacementSession.id).not.toBe(victimSession.id);
    const replacementExecution = await client.startExecute({
      actor: actor("partition-recovered"),
      command: "printf m96-recovered",
      idempotencyKey: "m96-recovered-execute",
      sessionGeneration: replacementSession.generation,
      sessionId: replacementSession.id,
    });
    expect((await client.waitExecution(replacementExecution.execution.id)).status).toBe(
      "COMPLETED",
    );
    expect((await client.getSession(victimSession.id)).status).toBe("BROKEN");
  }, 120_000);

  it("preserves durable claim and idempotent mutation truth across in-flight Router SIGKILL", async () => {
    const root = await realpath(await mkdtemp(join("/private/tmp", "itr-m97-crash-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const owners = await Promise.all([
      startRuntimeChild(
        root,
        "owner-router-crash-a",
        "instance-router-crash-a",
        join(root, "a.sock"),
      ),
      startRuntimeChild(
        root,
        "owner-router-crash-b",
        "instance-router-crash-b",
        join(root, "b.sock"),
      ),
    ]);
    children.push(...owners);
    const routerSocket = join(root, "router.sock");

    const claimCrash = await startRouterChild(routerSocket, "after-placement-claim");
    children.push(claimCrash);
    let client = new UnixRuntimeClient(routerSocket);
    await expect(
      client.createSession({ shell: "zsh", workspaceRoot: workspace }),
    ).rejects.toMatchObject({
      code: "DELIVERY_UNKNOWN",
      retryable: false,
    });
    await waitForExit(claimCrash);
    expect(claimCrash.process.signalCode).toBe("SIGKILL");
    const claimState = await pool.query<{
      owner_id: string;
      placement_count: string;
      session_count: string;
    }>(
      `SELECT worker.owner_id, worker.placement_count::text,
              count(session.id)::text AS session_count
         FROM runtime_workers worker
         LEFT JOIN sessions session ON session.owner_id = worker.owner_id
        WHERE worker.owner_id LIKE 'owner-router-crash-%'
        GROUP BY worker.owner_id, worker.placement_count
        ORDER BY worker.owner_id`,
    );
    expect(claimState.rows).toEqual([
      { owner_id: "owner-router-crash-a", placement_count: "1", session_count: "0" },
      { owner_id: "owner-router-crash-b", placement_count: "0", session_count: "0" },
    ]);

    const steadyRouter = await startRouterChild(routerSocket);
    children.push(steadyRouter);
    client = new UnixRuntimeClient(routerSocket);
    const session = await client.createSession({ shell: "zsh", workspaceRoot: workspace });
    expect(session.ownerId).toBe("owner-router-crash-b");
    const recoveredPlacement = await pool.query<{ owner_id: string; placement_count: string }>(
      `SELECT owner_id, placement_count::text
         FROM runtime_workers
        WHERE owner_id LIKE 'owner-router-crash-%'
        ORDER BY owner_id`,
    );
    expect(recoveredPlacement.rows).toEqual([
      { owner_id: "owner-router-crash-a", placement_count: "1" },
      { owner_id: "owner-router-crash-b", placement_count: "1" },
    ]);
    await stopChild(steadyRouter, "SIGTERM");

    const mutationCrash = await startRouterChild(routerSocket, "after-execution-start-forward");
    children.push(mutationCrash);
    client = new UnixRuntimeClient(routerSocket);
    const sideEffect = join(root, "router-mutation-side-effect.txt");
    const request = {
      actor: actor("router-crash-mutation"),
      command: `printf 'm97-once\\n' >> ${shellQuote(sideEffect)}`,
      idempotencyKey: "m97-router-crash-mutation",
      sessionGeneration: session.generation,
      sessionId: session.id,
    } as const;
    await expect(client.startExecute(request)).rejects.toMatchObject({
      code: "DELIVERY_UNKNOWN",
      retryable: false,
    });
    await waitForExit(mutationCrash);
    expect(mutationCrash.process.signalCode).toBe("SIGKILL");

    const recoveredRouter = await startRouterChild(routerSocket);
    children.push(recoveredRouter);
    client = new UnixRuntimeClient(routerSocket);
    const replay = await client.startExecute(request);
    expect((await client.waitExecution(replay.execution.id)).status).toBe("COMPLETED");
    expect(await readFile(sideEffect, "utf8")).toBe("m97-once\n");
    const durableMutation = await pool.query<{
      action_count: string;
      execution_count: string;
    }>(
      `SELECT count(DISTINCT action.id)::text AS action_count,
              count(DISTINCT execution.id)::text AS execution_count
         FROM actions action
         LEFT JOIN executions execution ON execution.action_id = action.id
        WHERE action.session_id = $1
          AND action.actor_id = $2
          AND action.idempotency_key = $3`,
      [session.id, request.actor.id, request.idempotencyKey],
    );
    expect(durableMutation.rows).toEqual([{ action_count: "1", execution_count: "1" }]);
  }, 120_000);

  it("settles root Session creation exactly once after post-forward Router SIGKILL and concurrent replay", async () => {
    const root = await realpath(await mkdtemp(join("/private/tmp", "itr-m98-create-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const owners = await Promise.all([
      startRuntimeChild(
        root,
        "owner-create-crash-a",
        "instance-create-crash-a",
        join(root, "a.sock"),
      ),
      startRuntimeChild(
        root,
        "owner-create-crash-b",
        "instance-create-crash-b",
        join(root, "b.sock"),
      ),
    ]);
    children.push(...owners);
    const routerSocket = join(root, "router.sock");
    const crashingRouter = await startRouterChild(routerSocket, "after-session-create-forward");
    children.push(crashingRouter);
    let client = new UnixRuntimeClient(routerSocket);
    const request = {
      idempotencyKey: "m98-post-forward-session-create",
      shell: "zsh" as const,
      workspaceRoot: workspace,
    };

    await expect(client.createSession(request)).rejects.toMatchObject({
      code: "DELIVERY_UNKNOWN",
      retryable: false,
    });
    await waitForExit(crashingRouter);
    expect(crashingRouter.process.signalCode).toBe("SIGKILL");
    const committed = await pool.query<{
      owner_id: string;
      session_count: string;
      session_id: string;
    }>(
      `SELECT creation.owner_id, creation.session_id,
              count(session.id)::text AS session_count
         FROM session_creation_requests creation
         JOIN sessions session ON session.id = creation.session_id
        WHERE creation.idempotency_key = $1
        GROUP BY creation.owner_id, creation.session_id`,
      [request.idempotencyKey],
    );
    expect(committed.rows).toHaveLength(1);
    expect(committed.rows[0]?.session_count).toBe("1");
    const committedSessionId = committed.rows[0]?.session_id;
    if (committedSessionId === undefined) throw new Error("Committed Session ID is missing");

    const steadyRouter = await startRouterChild(routerSocket);
    children.push(steadyRouter);
    client = new UnixRuntimeClient(routerSocket);
    const replay = await client.createSession(request);
    expect(replay.id).toBe(committedSessionId);
    expect(replay.status).toBe("READY");
    await expect(client.createSession({ ...request, shell: "bash" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });

    const secondRouterSocket = join(root, "router-second.sock");
    children.push(await startRouterChild(secondRouterSocket));
    const secondClient = new UnixRuntimeClient(secondRouterSocket);
    const concurrentRequest = {
      ...request,
      idempotencyKey: "m98-concurrent-router-session-create",
    };
    const [left, right] = await Promise.all([
      client.createSession(concurrentRequest),
      secondClient.createSession(concurrentRequest),
    ]);
    expect(right.id).toBe(left.id);
    const durableCreates = await pool.query<{
      creation_count: string;
      placement_count: string;
      session_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM session_creation_requests
           WHERE idempotency_key IN ($1, $2)) AS creation_count,
         (SELECT sum(placement_count)::text FROM runtime_workers
           WHERE owner_id LIKE 'owner-create-crash-%') AS placement_count,
         (SELECT count(*)::text FROM sessions
           WHERE id IN (SELECT session_id FROM session_creation_requests
                          WHERE idempotency_key IN ($1, $2))) AS session_count`,
      [request.idempotencyKey, concurrentRequest.idempotencyKey],
    );
    expect(durableCreates.rows).toEqual([
      { creation_count: "2", placement_count: "2", session_count: "2" },
    ]);

    const executed = await client.startExecute({
      actor: actor("root-create-replay"),
      command: "printf m98-root-create-replay",
      idempotencyKey: "m98-root-create-replay-execute",
      sessionGeneration: replay.generation,
      sessionId: replay.id,
    });
    const completed = await client.waitExecution(executed.execution.id);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.output).toContain("m98-root-create-replay");
  }, 120_000);

  async function startRuntimeChild(
    root: string,
    ownerId: string,
    instanceId: string,
    socketPath: string,
    connectionString = databaseUrl ?? "",
  ): Promise<ManagedChild> {
    const child = startChild(`runtime-${ownerId}`, "apps/runtime-daemon/src/main.ts", {
      ITERM_DATABASE_HEALTH_CHECK_MS: "100",
      ITERM_DATABASE_RECONNECT_INITIAL_MS: "50",
      ITERM_DATABASE_RECONNECT_MAX_MS: "50",
      ITERM_DATABASE_STATEMENT_TIMEOUT_MS: "500",
      ITERM_DATABASE_URL: connectionString,
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

  async function startRouterChild(
    socketPath: string,
    failpoint?:
      "after-execution-start-forward" | "after-placement-claim" | "after-session-create-forward",
  ): Promise<ManagedChild> {
    const child = startChild(
      failpoint === undefined ? "router" : `router-${failpoint}`,
      failpoint === undefined
        ? "apps/runtime-router/src/main.ts"
        : "apps/runtime-router/src/fixtures/crash-router.ts",
      {
        ITERM_DATABASE_URL: databaseUrl ?? "",
        ITERM_ROUTER_SOCKET: socketPath,
        ...(failpoint === undefined ? {} : { ITERM_TEST_FAILPOINT: failpoint }),
      },
    );
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

  async function waitForOwnerExpiry(ownerId: string, timeoutMilliseconds: number): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMilliseconds) {
      const result = await pool.query<{ expired: boolean }>(
        "SELECT lease_expires_at <= now() AS expired FROM runtime_workers WHERE owner_id = $1",
        [ownerId],
      );
      if (result.rows[0]?.expired === true) return;
      await delay(25);
    }
    throw new Error(`Owner ${ownerId} lease did not expire`);
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

async function waitForOccurrence(
  child: ManagedChild,
  expected: string,
  count: number,
  timeoutMilliseconds: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMilliseconds) {
    if (occurrenceCount(child.stderr, expected) >= count) return;
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      throw new Error(`${child.label} exited before repeated ${expected}: ${child.stderr}`);
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${child.label} repeated ${expected}: ${child.stderr}`);
}

function occurrenceCount(value: string, expected: string): number {
  return value.split(expected).length - 1;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function proxyFor(url: string): Promise<TcpFaultProxy> {
  const parsed = new URL(url);
  const upstreamPort = Number.parseInt(parsed.port || "5432", 10);
  return startTcpFaultProxy({ upstreamHost: parsed.hostname, upstreamPort });
}

function throughProxy(url: string, proxy: TcpFaultProxy): string {
  const parsed = new URL(url);
  parsed.hostname = proxy.host;
  parsed.port = proxy.port.toString();
  return parsed.toString();
}
