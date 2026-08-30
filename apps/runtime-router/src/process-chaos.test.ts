import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
    await pool.query(
      `UPDATE session_creation_policies
          SET retention_milliseconds = 86400000,
              max_requests = 100000,
              cleanup_batch_size = 1000,
              updated_at = now()
        WHERE scope = 'default'`,
    );
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

  it("isolates a Router-only PostgreSQL blackhole while another Router and both owners progress", async () => {
    const root = await realpath(await mkdtemp(join("/private/tmp", "itr-m99-router-part-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const owners = await Promise.all([
      startRuntimeChild(
        root,
        "owner-router-partition-a",
        "instance-router-partition-a",
        join(root, "a.sock"),
      ),
      startRuntimeChild(
        root,
        "owner-router-partition-b",
        "instance-router-partition-b",
        join(root, "b.sock"),
      ),
    ]);
    children.push(...owners);
    const proxy = await proxyFor(databaseUrl ?? "");
    proxies.push(proxy);
    const isolatedSocket = join(root, "router-isolated.sock");
    const healthySocket = join(root, "router-healthy.sock");
    const isolatedRouter = await startRouterChild(
      isolatedSocket,
      undefined,
      throughProxy(databaseUrl ?? "", proxy),
      300,
    );
    const healthyRouter = await startRouterChild(healthySocket);
    children.push(isolatedRouter, healthyRouter);
    const isolated = new UnixRuntimeClient(isolatedSocket);
    const healthy = new UnixRuntimeClient(healthySocket);
    const first = await isolated.createSession({
      idempotencyKey: "m99-initial-session-create",
      shell: "zsh",
      workspaceRoot: workspace,
    });

    proxy.setMode("BLACKHOLE");
    const unavailableAt = Date.now();
    await expect(isolated.getSession(first.id)).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      details: {
        component: "runtime-router",
        operation: "session.get",
        phase: "route_resolution",
      },
      retryable: true,
    });
    expect(Date.now() - unavailableAt).toBeLessThan(3_000);
    const isolatedCreate = {
      idempotencyKey: "m99-isolated-session-create",
      shell: "zsh" as const,
      workspaceRoot: workspace,
    };
    await expect(isolated.createSession(isolatedCreate)).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      details: {
        component: "runtime-router",
        operation: "session.create",
        phase: "route_resolution",
      },
      retryable: true,
    });
    expect(isolatedRouter.process.exitCode).toBeNull();
    expect(isolatedRouter.process.signalCode).toBeNull();
    expect(
      await pool.query("SELECT 1 FROM session_creation_requests WHERE idempotency_key = $1", [
        isolatedCreate.idempotencyKey,
      ]),
    ).toMatchObject({ rowCount: 0 });

    expect((await healthy.getSession(first.id)).id).toBe(first.id);
    const healthyExecution = await healthy.startExecute({
      actor: actor("router-partition-healthy"),
      command: "printf m99-healthy-router",
      idempotencyKey: "m99-healthy-router-execute",
      sessionGeneration: first.generation,
      sessionId: first.id,
    });
    const healthyCompleted = await healthy.waitExecution(healthyExecution.execution.id);
    expect(healthyCompleted.status).toBe("COMPLETED");
    expect(healthyCompleted.output).toContain("m99-healthy-router");
    const duringPartition = await healthy.createSession({
      idempotencyKey: "m99-healthy-session-create",
      shell: "zsh",
      workspaceRoot: workspace,
    });
    expect(duringPartition.id).not.toBe(first.id);

    proxy.setMode("CUT");
    proxy.setMode("FORWARD");
    const recovered = await waitForSessionStatus(isolated, first.id, "READY", 10_000);
    expect(recovered.id).toBe(first.id);
    const settled = await isolated.createSession(isolatedCreate);
    const durable = await pool.query<{
      creation_count: string;
      placement_count: string;
      session_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM session_creation_requests
           WHERE idempotency_key = $1) AS creation_count,
         (SELECT sum(placement_count)::text FROM runtime_workers
           WHERE owner_id LIKE 'owner-router-partition-%') AS placement_count,
         (SELECT count(*)::text FROM sessions
           WHERE id IN (SELECT session_id FROM session_creation_requests
                          WHERE idempotency_key = $1)) AS session_count`,
      [isolatedCreate.idempotencyKey],
    );
    expect(durable.rows).toEqual([
      { creation_count: "1", placement_count: "3", session_count: "1" },
    ]);
    const recoveredExecution = await isolated.startExecute({
      actor: actor("router-partition-recovered"),
      command: "printf m99-recovered-router",
      idempotencyKey: "m99-recovered-router-execute",
      sessionGeneration: settled.generation,
      sessionId: settled.id,
    });
    const recoveredCompleted = await isolated.waitExecution(recoveredExecution.execution.id);
    expect(recoveredCompleted.status).toBe("COMPLETED");
    expect(recoveredCompleted.output).toContain("m99-recovered-router");
  }, 120_000);

  it("keeps a cold-start Router degraded until PostgreSQL becomes reachable", async () => {
    const root = await realpath(await mkdtemp(join("/private/tmp", "itr-m910-router-cold-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const owners = await Promise.all([
      startRuntimeChild(
        root,
        "owner-router-cold-a",
        "instance-router-cold-a",
        join(root, "a.sock"),
      ),
      startRuntimeChild(
        root,
        "owner-router-cold-b",
        "instance-router-cold-b",
        join(root, "b.sock"),
      ),
    ]);
    children.push(...owners);
    const healthySocket = join(root, "router-healthy.sock");
    children.push(await startRouterChild(healthySocket));
    const healthy = new UnixRuntimeClient(healthySocket);
    const baseline = await healthy.createSession({
      idempotencyKey: "m910-baseline-session-create",
      shell: "zsh",
      workspaceRoot: workspace,
    });

    const proxy = await proxyFor(databaseUrl ?? "");
    proxies.push(proxy);
    proxy.setMode("BLACKHOLE");
    const coldSocket = join(root, "router-cold.sock");
    const coldRouter = await startRouterChild(
      coldSocket,
      undefined,
      throughProxy(databaseUrl ?? "", proxy),
      300,
      false,
    );
    children.push(coldRouter);
    const cold = new UnixRuntimeClient(coldSocket);
    const coldCreate = {
      idempotencyKey: "m910-cold-session-create",
      shell: "zsh" as const,
      workspaceRoot: workspace,
    };
    await expect(cold.createSession(coldCreate)).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      details: {
        component: "runtime-router",
        operation: "session.create",
        phase: "route_resolution",
      },
      retryable: true,
    });
    await waitForText(coldRouter, "Runtime Router PostgreSQL unavailable", 10_000);
    expect(coldRouter.process.exitCode).toBeNull();
    expect(
      await pool.query("SELECT 1 FROM session_creation_requests WHERE idempotency_key = $1", [
        coldCreate.idempotencyKey,
      ]),
    ).toMatchObject({ rowCount: 0 });

    const healthyExecution = await healthy.startExecute({
      actor: actor("router-cold-healthy"),
      command: "printf m910-healthy-router",
      idempotencyKey: "m910-healthy-router-execute",
      sessionGeneration: baseline.generation,
      sessionId: baseline.id,
    });
    expect((await healthy.waitExecution(healthyExecution.execution.id)).status).toBe("COMPLETED");
    const duringColdStart = await healthy.createSession({
      idempotencyKey: "m910-healthy-session-create",
      shell: "zsh",
      workspaceRoot: workspace,
    });
    expect(duringColdStart.id).not.toBe(baseline.id);

    proxy.setMode("CUT");
    proxy.setMode("FORWARD");
    await waitForText(coldRouter, "Runtime Router PostgreSQL ready", 10_000);
    const recovered = await cold.createSession(coldCreate);
    const recoveredExecution = await cold.startExecute({
      actor: actor("router-cold-recovered"),
      command: "printf m910-recovered-router",
      idempotencyKey: "m910-recovered-router-execute",
      sessionGeneration: recovered.generation,
      sessionId: recovered.id,
    });
    const completed = await cold.waitExecution(recoveredExecution.execution.id);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.output).toContain("m910-recovered-router");
    const durable = await pool.query<{
      creation_count: string;
      placement_count: string;
      session_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM session_creation_requests
           WHERE idempotency_key = $1) AS creation_count,
         (SELECT sum(placement_count)::text FROM runtime_workers
           WHERE owner_id LIKE 'owner-router-cold-%') AS placement_count,
         (SELECT count(*)::text FROM sessions
           WHERE id IN (SELECT session_id FROM session_creation_requests
                          WHERE idempotency_key = $1)) AS session_count`,
      [coldCreate.idempotencyKey],
    );
    expect(durable.rows).toEqual([
      { creation_count: "1", placement_count: "3", session_count: "1" },
    ]);
  }, 120_000);

  it("bounds root creation keys while preserving live replay and reclaiming terminal capacity", async () => {
    await pool.query(
      `UPDATE session_creation_policies
          SET retention_milliseconds = 100, max_requests = 2, cleanup_batch_size = 2
        WHERE scope = 'default'`,
    );
    const root = await realpath(await mkdtemp(join("/private/tmp", "itr-m911-retention-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    children.push(
      await startRuntimeChild(
        root,
        "owner-creation-retention",
        "instance-creation-retention",
        join(root, "runtime.sock"),
      ),
    );
    const routerSocket = join(root, "router.sock");
    children.push(await startRouterChild(routerSocket));
    const client = new UnixRuntimeClient(routerSocket);
    const firstRequest = {
      idempotencyKey: "m911-retained-first",
      shell: "zsh" as const,
      workspaceRoot: workspace,
    };
    const secondRequest = {
      idempotencyKey: "m911-retained-second",
      shell: "zsh" as const,
      workspaceRoot: workspace,
    };
    const thirdRequest = {
      idempotencyKey: "m911-reclaimed-third",
      shell: "zsh" as const,
      workspaceRoot: workspace,
    };
    const first = await client.createSession(firstRequest);
    const second = await client.createSession(secondRequest);
    await delay(150);

    await expect(client.createSession(thirdRequest)).rejects.toMatchObject({
      code: "BACKPRESSURE",
      details: {
        currentRequests: 2,
        limit: 2,
        phase: "idempotency_admission",
      },
      retryable: true,
    });
    expect(await client.createSession(firstRequest)).toMatchObject({ id: first.id });
    const beforeCleanup = await pool.query<{
      placement_count: string;
      request_count: string;
      session_count: string;
    }>(
      `SELECT
         (SELECT placement_count::text FROM runtime_workers
           WHERE owner_id = 'owner-creation-retention') AS placement_count,
         (SELECT count(*)::text FROM session_creation_requests) AS request_count,
         (SELECT count(*)::text FROM sessions) AS session_count`,
    );
    expect(beforeCleanup.rows).toEqual([
      { placement_count: "2", request_count: "2", session_count: "2" },
    ]);

    expect((await client.closeSession(first.id, first.generation)).status).toBe("CLOSED");
    const third = await client.createSession(thirdRequest);
    const thirdExecution = await client.startExecute({
      actor: actor("retention-third"),
      command: "printf m911-retention-third",
      idempotencyKey: "m911-retention-third-execute",
      sessionGeneration: third.generation,
      sessionId: third.id,
    });
    const thirdCompleted = await client.waitExecution(thirdExecution.execution.id);
    expect(thirdCompleted.status).toBe("COMPLETED");
    expect(thirdCompleted.output).toContain("m911-retention-third");

    expect((await client.closeSession(second.id, second.generation)).status).toBe("CLOSED");
    const reusedAfterExpiry = await client.createSession(firstRequest);
    expect(reusedAfterExpiry.id).not.toBe(first.id);
    const reusedExecution = await client.startExecute({
      actor: actor("retention-reused"),
      command: "printf m911-retention-reused",
      idempotencyKey: "m911-retention-reused-execute",
      sessionGeneration: reusedAfterExpiry.generation,
      sessionId: reusedAfterExpiry.id,
    });
    const reusedCompleted = await client.waitExecution(reusedExecution.execution.id);
    expect(reusedCompleted.status).toBe("COMPLETED");
    expect(reusedCompleted.output).toContain("m911-retention-reused");

    const retained = await pool.query<{
      completed: boolean;
      idempotency_key: string;
    }>(
      `SELECT idempotency_key, completed_at IS NOT NULL AS completed
         FROM session_creation_requests
        ORDER BY idempotency_key`,
    );
    expect(retained.rows).toEqual([
      { completed: true, idempotency_key: "m911-reclaimed-third" },
      { completed: true, idempotency_key: "m911-retained-first" },
    ]);
    const finalCounts = await pool.query<{
      placement_count: string;
      request_count: string;
      session_count: string;
    }>(
      `SELECT
         (SELECT placement_count::text FROM runtime_workers
           WHERE owner_id = 'owner-creation-retention') AS placement_count,
         (SELECT count(*)::text FROM session_creation_requests) AS request_count,
         (SELECT count(*)::text FROM sessions) AS session_count`,
    );
    expect(finalCounts.rows).toEqual([
      { placement_count: "4", request_count: "2", session_count: "4" },
    ]);
  }, 120_000);

  it("settles a pre-drain placement before the selected Runtime stops", async () => {
    const root = await realpath(await mkdtemp(join("/private/tmp", "itr-m912-drain-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const ownerA = await startRuntimeChild(
      root,
      "owner-drain-a",
      "instance-drain-a",
      join(root, "a.sock"),
    );
    const ownerB = await startRuntimeChild(
      root,
      "owner-drain-b",
      "instance-drain-b",
      join(root, "b.sock"),
    );
    children.push(ownerA, ownerB);
    const releasePath = join(root, "release-placement");
    const routerSocket = join(root, "router.sock");
    const router = startChild(
      "router-delayed-placement",
      "apps/runtime-router/src/fixtures/delayed-placement-router.ts",
      {
        ITERM_DATABASE_URL: databaseUrl ?? "",
        ITERM_ROUTER_SOCKET: routerSocket,
        ITERM_TEST_DELAY_OWNER_ID: "owner-drain-a",
        ITERM_TEST_DELAY_RELEASE_PATH: releasePath,
      },
    );
    children.push(router);
    await waitForText(router, "Runtime Router listening", 15_000);
    const client = new UnixRuntimeClient(routerSocket);
    const drainingRequest = {
      idempotencyKey: "m912-pre-drain-create",
      shell: "zsh" as const,
      workspaceRoot: workspace,
    };
    const pendingCreation = client.createSession(drainingRequest);
    void pendingCreation.catch(() => undefined);
    await waitForText(router, "placement paused owner=owner-drain-a", 10_000);
    const claimed = await pool.query<{ session_id: string | null }>(
      "SELECT session_id FROM session_creation_requests WHERE idempotency_key = $1",
      [drainingRequest.idempotencyKey],
    );
    expect(claimed.rows).toEqual([{ session_id: null }]);

    ownerA.process.kill("SIGTERM");
    await waitForOwnerStatus("owner-drain-a", "DRAINING");
    await waitForText(ownerA, "Runtime drain draining pending_session_creations=1", 10_000);
    expect(ownerA.process.exitCode).toBeNull();

    const healthy = await client.createSession({
      idempotencyKey: "m912-healthy-create",
      shell: "zsh",
      workspaceRoot: workspace,
    });
    expect(healthy.ownerId).toBe("owner-drain-b");
    const healthyExecution = await client.startExecute({
      actor: actor("drain-healthy"),
      command: "printf m912-drain-healthy",
      idempotencyKey: "m912-drain-healthy-execute",
      sessionGeneration: healthy.generation,
      sessionId: healthy.id,
    });
    expect((await client.waitExecution(healthyExecution.execution.id)).output).toContain(
      "m912-drain-healthy",
    );

    await writeFile(releasePath, "release\n", "utf8");
    const settled = await pendingCreation;
    expect(settled.ownerId).toBe("owner-drain-a");
    await waitForText(ownerA, "Runtime drain settled pending_session_creations=0", 10_000);
    await waitForExit(ownerA, 15_000);
    expect(ownerA.process.exitCode).toBe(0);
    const durable = await pool.query<{
      owner_status: string;
      session_id: string;
      session_status: string;
    }>(
      `SELECT worker.status AS owner_status,
              request.session_id,
              session.status AS session_status
         FROM session_creation_requests AS request
         JOIN sessions AS session ON session.id = request.session_id
         JOIN runtime_workers AS worker ON worker.owner_id = request.owner_id
        WHERE request.idempotency_key = $1`,
      [drainingRequest.idempotencyKey],
    );
    expect(durable.rows).toEqual([
      {
        owner_status: "STOPPED",
        session_id: settled.id,
        session_status: "CLOSED",
      },
    ]);
    expect(
      await pool.query(
        `SELECT 1 FROM session_creation_requests
          WHERE owner_id = 'owner-drain-a' AND session_id IS NULL`,
      ),
    ).toMatchObject({ rowCount: 0 });
  }, 120_000);

  it("keeps root creation progressing across repeated rolling owner drains", async () => {
    const root = await realpath(await mkdtemp(join("/private/tmp", "itr-m913-rolling-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const ownerIds = ["owner-rolling-a", "owner-rolling-b", "owner-rolling-c"] as const;
    const ownerSockets = new Map(
      ownerIds.map((ownerId, index) => [ownerId, join(root, `owner-${index.toString()}.sock`)]),
    );
    const incarnations = new Map(ownerIds.map((ownerId) => [ownerId, 1]));
    const activeOwners = new Map<string, ManagedChild>();
    const initialOwners = await Promise.all(
      ownerIds.map(async (ownerId) => {
        const socketPath = ownerSockets.get(ownerId);
        if (socketPath === undefined) throw new Error(`Socket is missing for ${ownerId}`);
        return startRuntimeChild(root, ownerId, `instance-${ownerId}-1`, socketPath);
      }),
    );
    for (const [index, owner] of initialOwners.entries()) {
      const ownerId = ownerIds[index];
      if (ownerId === undefined)
        throw new Error(`Owner ID is missing at index ${index.toString()}`);
      activeOwners.set(ownerId, owner);
    }
    children.push(...initialOwners);
    const routerSocket = join(root, "router.sock");
    const router = await startRouterChild(routerSocket);
    children.push(router);
    const client = new UnixRuntimeClient(routerSocket);
    const submittedKeys: string[] = [];
    const settledSessionIds = new Set<string>();
    const drainOrder = [...ownerIds, ...ownerIds];

    for (const [round, targetOwnerId] of drainOrder.entries()) {
      const keys = Array.from(
        { length: 8 },
        (_, index) => `m913-round-${round.toString()}-create-${index.toString()}`,
      );
      submittedKeys.push(...keys);
      const creating = Promise.all(
        keys.map((idempotencyKey) =>
          client.createSession({ idempotencyKey, shell: "zsh", workspaceRoot: workspace }),
        ),
      );
      await delay(5);
      const drainingOwner = activeOwners.get(targetOwnerId);
      if (drainingOwner === undefined) throw new Error(`Active owner is missing: ${targetOwnerId}`);
      drainingOwner.process.kill("SIGTERM");

      const sessions = await creating;
      for (const session of sessions) {
        expect(settledSessionIds.has(session.id)).toBe(false);
        settledSessionIds.add(session.id);
      }
      await waitForText(drainingOwner, "Runtime drain settled pending_session_creations=0", 10_000);
      await waitForExit(drainingOwner, 15_000);
      expect(drainingOwner.process.exitCode).toBe(0);
      await waitForOwnerStatus(targetOwnerId, "STOPPED");
      expect(
        await pool.query(
          `SELECT 1 FROM session_creation_requests
            WHERE owner_id = $1 AND session_id IS NULL`,
          [targetOwnerId],
        ),
      ).toMatchObject({ rowCount: 0 });

      const healthy = sessions.find((session) => session.ownerId !== targetOwnerId);
      if (healthy === undefined)
        throw new Error(`Round ${round.toString()} has no healthy Session`);
      const marker = `m913-round-${round.toString()}-healthy`;
      const execution = await client.startExecute({
        actor: actor(`rolling-${round.toString()}`),
        command: `printf ${marker}`,
        idempotencyKey: `${marker}-execute`,
        sessionGeneration: healthy.generation,
        sessionId: healthy.id,
      });
      expect((await client.waitExecution(execution.execution.id)).output).toContain(marker);
      await Promise.all(
        sessions
          .filter((session) => session.ownerId !== targetOwnerId)
          .map((session) => client.closeSession(session.id, session.generation)),
      );

      const previousIncarnation = incarnations.get(targetOwnerId);
      const socketPath = ownerSockets.get(targetOwnerId);
      if (previousIncarnation === undefined || socketPath === undefined) {
        throw new Error(`Replacement metadata is missing: ${targetOwnerId}`);
      }
      const nextIncarnation = previousIncarnation + 1;
      const replacement = await startRuntimeChild(
        root,
        targetOwnerId,
        `instance-${targetOwnerId}-${nextIncarnation.toString()}`,
        socketPath,
      );
      children.push(replacement);
      activeOwners.set(targetOwnerId, replacement);
      incarnations.set(targetOwnerId, nextIncarnation);
      const registered = await pool.query<{
        instance_id: string;
        registry_epoch: string;
        status: string;
      }>(
        `SELECT instance_id, registry_epoch::text, status
           FROM runtime_workers
          WHERE owner_id = $1`,
        [targetOwnerId],
      );
      expect(registered.rows).toEqual([
        {
          instance_id: `instance-${targetOwnerId}-${nextIncarnation.toString()}`,
          registry_epoch: nextIncarnation.toString(),
          status: "ACTIVE",
        },
      ]);
    }

    expect(settledSessionIds.size).toBe(submittedKeys.length);
    const durable = await pool.query<{
      bound_session_count: string;
      live_session_count: string;
      request_count: string;
      unfinished_count: string;
    }>(
      `SELECT
         count(*)::text AS request_count,
         count(DISTINCT request.session_id)::text AS bound_session_count,
         count(*) FILTER (WHERE request.session_id IS NULL)::text AS unfinished_count,
         (SELECT count(*)::text FROM sessions WHERE status <> 'CLOSED') AS live_session_count
       FROM session_creation_requests AS request`,
    );
    expect(durable.rows).toEqual([
      {
        bound_session_count: submittedKeys.length.toString(),
        live_session_count: "0",
        request_count: submittedKeys.length.toString(),
        unfinished_count: "0",
      },
    ]);
    const finalOwners = await pool.query<{
      instance_id: string;
      owner_id: string;
      registry_epoch: string;
      status: string;
    }>(
      `SELECT owner_id, instance_id, registry_epoch::text, status
         FROM runtime_workers
        ORDER BY owner_id`,
    );
    expect(finalOwners.rows).toEqual(
      ownerIds.map((ownerId) => ({
        instance_id: `instance-${ownerId}-3`,
        owner_id: ownerId,
        registry_epoch: "3",
        status: "ACTIVE",
      })),
    );
  }, 180_000);

  it("fences a CPU-starved owner before same-process recovery", async () => {
    const root = await realpath(await mkdtemp(join("/private/tmp", "itr-m914-starved-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const ownerA = await startRuntimeChild(
      root,
      "owner-starved-a",
      "instance-starved-a",
      join(root, "a.sock"),
    );
    const ownerB = await startRuntimeChild(
      root,
      "owner-starved-b",
      "instance-starved-b",
      join(root, "b.sock"),
    );
    children.push(ownerA, ownerB);
    const routerSocket = join(root, "router.sock");
    const router = await startRouterChild(routerSocket);
    children.push(router);
    const client = new UnixRuntimeClient(routerSocket);

    const victim = await client.createSession({
      idempotencyKey: "m914-victim-create",
      shell: "zsh",
      workspaceRoot: workspace,
    });
    expect(victim.ownerId).toBe("owner-starved-a");
    const sleeping = await client.startExecute({
      actor: actor("starved-victim"),
      command: "sleep 30",
      idempotencyKey: "m914-victim-sleep",
      sessionGeneration: victim.generation,
      sessionId: victim.id,
    });
    await waitForExecutionStatus(client, sleeping.execution.id, "RUNNING");
    const shell = await pool.query<{ shell_pid: number }>(
      `SELECT shell_pid FROM session_generations
        WHERE session_id = $1 AND generation = $2`,
      [victim.id, victim.generation],
    );
    const shellPid = shell.rows[0]?.shell_pid;
    if (shellPid === undefined) throw new Error("Starved owner Shell PID is missing");

    expect(ownerA.process.kill("SIGSTOP")).toBe(true);
    await waitForOwnerExpiry("owner-starved-a", 5_000);
    const expired = await pool.query<{
      registry_epoch: string;
      status: string;
      version: string;
    }>(
      `SELECT registry_epoch::text, status, version::text
         FROM runtime_workers WHERE owner_id = 'owner-starved-a'`,
    );
    expect(expired.rows[0]).toMatchObject({ registry_epoch: "1", status: "ACTIVE" });

    const healthy = await client.createSession({
      idempotencyKey: "m914-healthy-create",
      shell: "zsh",
      workspaceRoot: workspace,
    });
    expect(healthy.ownerId).toBe("owner-starved-b");
    const healthyExecution = await client.startExecute({
      actor: actor("starved-healthy"),
      command: "printf m914-starved-healthy",
      idempotencyKey: "m914-healthy-execute",
      sessionGeneration: healthy.generation,
      sessionId: healthy.id,
    });
    expect((await client.waitExecution(healthyExecution.execution.id)).output).toContain(
      "m914-starved-healthy",
    );

    expect(ownerA.process.kill("SIGCONT")).toBe(true);
    await waitForOccurrence(ownerA, "Runtime PostgreSQL connecting", 2, 10_000);
    await waitUntilProcessGone(shellPid);
    await waitForOccurrence(ownerA, "Runtime PostgreSQL ready", 2, 15_000);
    const broken = await waitForSessionStatus(client, victim.id, "BROKEN", 10_000);
    expect(broken).toMatchObject({ generation: victim.generation, id: victim.id });
    const recovered = await pool.query<{
      instance_id: string;
      lease_released_at: Date | null;
      registry_epoch: string;
      session_status: string;
      status: string;
    }>(
      `SELECT worker.instance_id, worker.registry_epoch::text, worker.status,
              session.status AS session_status, lease.released_at AS lease_released_at
         FROM runtime_workers AS worker
         JOIN sessions AS session ON session.owner_id = worker.owner_id
         JOIN session_leases AS lease
           ON lease.session_id = session.id
          AND lease.session_generation = session.current_generation
        WHERE worker.owner_id = 'owner-starved-a' AND session.id = $1`,
      [victim.id],
    );
    expect(recovered.rows[0]).toMatchObject({
      instance_id: "instance-starved-a",
      registry_epoch: "1",
      session_status: "BROKEN",
      status: "ACTIVE",
    });
    expect(recovered.rows[0]?.lease_released_at).not.toBeNull();

    expect(ownerA.process.exitCode).toBeNull();
    const recoveredClient = new UnixRuntimeClient(join(root, "a.sock"));
    const replacementSession = await recoveredClient.createSession({
      idempotencyKey: "m914-recovered-create",
      shell: "zsh",
      workspaceRoot: workspace,
    });
    expect(replacementSession).toMatchObject({ generation: 1, ownerId: "owner-starved-a" });
    expect(replacementSession.id).not.toBe(victim.id);
    const replacementExecution = await recoveredClient.startExecute({
      actor: actor("starved-recovered"),
      command: "printf m914-starved-recovered",
      idempotencyKey: "m914-recovered-execute",
      sessionGeneration: replacementSession.generation,
      sessionId: replacementSession.id,
    });
    expect(
      (await recoveredClient.waitExecution(replacementExecution.execution.id)).output,
    ).toContain("m914-starved-recovered");
  }, 120_000);

  it("preserves capacity-weighted placement across drain and replacement", async () => {
    const root = await realpath(await mkdtemp(join("/private/tmp", "itr-m915-weighted-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const ownerSockets = {
      "owner-weighted-a": join(root, "a.sock"),
      "owner-weighted-b": join(root, "b.sock"),
      "owner-weighted-c": join(root, "c.sock"),
    } as const;
    const weightedOwners = await Promise.all(
      [
        { capacityWeight: 1, ownerId: "owner-weighted-a" as const },
        { capacityWeight: 2, ownerId: "owner-weighted-b" as const },
        { capacityWeight: 3, ownerId: "owner-weighted-c" as const },
      ].map(({ capacityWeight, ownerId }) =>
        startRuntimeChild(
          root,
          ownerId,
          `instance-${ownerId}-1`,
          ownerSockets[ownerId],
          databaseUrl ?? "",
          capacityWeight,
        ),
      ),
    );
    children.push(...weightedOwners);
    const routerSocket = join(root, "router.sock");
    const router = await startRouterChild(routerSocket);
    children.push(router);
    const client = new UnixRuntimeClient(routerSocket);

    const firstWave = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        client.createSession({
          idempotencyKey: `m915-first-${index.toString()}`,
          shell: "zsh",
          workspaceRoot: workspace,
        }),
      ),
    );
    expect(ownerCounts(firstWave)).toEqual({
      "owner-weighted-a": 2,
      "owner-weighted-b": 4,
      "owner-weighted-c": 6,
    });
    await proveWeightedShells(client, firstWave, "m915-first");
    await Promise.all(
      firstWave.map((session) => client.closeSession(session.id, session.generation)),
    );

    const highCapacity = requiredChild(weightedOwners, "runtime-owner-weighted-c");
    highCapacity.process.kill("SIGTERM");
    await waitForExit(highCapacity, 15_000);
    expect(highCapacity.process.exitCode).toBe(0);
    await waitForOwnerStatus("owner-weighted-c", "STOPPED");
    const secondWave = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        client.createSession({
          idempotencyKey: `m915-second-${index.toString()}`,
          shell: "zsh",
          workspaceRoot: workspace,
        }),
      ),
    );
    expect(ownerCounts(secondWave)).toEqual({
      "owner-weighted-a": 2,
      "owner-weighted-b": 4,
    });
    await Promise.all(
      secondWave.map((session) => client.closeSession(session.id, session.generation)),
    );

    const replacement = await startRuntimeChild(
      root,
      "owner-weighted-c",
      "instance-owner-weighted-c-2",
      ownerSockets["owner-weighted-c"],
      databaseUrl ?? "",
      3,
    );
    children.push(replacement);
    const replaced = await pool.query<{
      capacity_weight: number;
      placement_count: string;
      registry_epoch: string;
      status: string;
    }>(
      `SELECT capacity_weight, placement_count::text, registry_epoch::text, status
         FROM runtime_workers WHERE owner_id = 'owner-weighted-c'`,
    );
    expect(replaced.rows).toEqual([
      {
        capacity_weight: 3,
        placement_count: "6",
        registry_epoch: "2",
        status: "ACTIVE",
      },
    ]);

    const thirdWave = await Promise.all(
      Array.from({ length: 18 }, (_, index) =>
        client.createSession({
          idempotencyKey: `m915-third-${index.toString()}`,
          shell: "zsh",
          workspaceRoot: workspace,
        }),
      ),
    );
    expect(ownerCounts(thirdWave)).toEqual({
      "owner-weighted-a": 2,
      "owner-weighted-b": 4,
      "owner-weighted-c": 12,
    });
    await proveWeightedShells(client, thirdWave, "m915-third");
    await Promise.all(
      thirdWave.map((session) => client.closeSession(session.id, session.generation)),
    );
    const finalPlacement = await pool.query<{
      capacity_weight: number;
      owner_id: string;
      placement_count: string;
    }>(
      `SELECT owner_id, capacity_weight, placement_count::text
         FROM runtime_workers
        WHERE owner_id LIKE 'owner-weighted-%'
        ORDER BY owner_id`,
    );
    expect(finalPlacement.rows).toEqual([
      { capacity_weight: 1, owner_id: "owner-weighted-a", placement_count: "6" },
      { capacity_weight: 2, owner_id: "owner-weighted-b", placement_count: "12" },
      { capacity_weight: 3, owner_id: "owner-weighted-c", placement_count: "18" },
    ]);
  }, 120_000);

  async function startRuntimeChild(
    root: string,
    ownerId: string,
    instanceId: string,
    socketPath: string,
    connectionString = databaseUrl ?? "",
    capacityWeight = 1,
  ): Promise<ManagedChild> {
    const child = startChild(`runtime-${ownerId}`, "apps/runtime-daemon/src/main.ts", {
      ITERM_DATABASE_HEALTH_CHECK_MS: "100",
      ITERM_DATABASE_RECONNECT_INITIAL_MS: "50",
      ITERM_DATABASE_RECONNECT_MAX_MS: "50",
      ITERM_DATABASE_STATEMENT_TIMEOUT_MS: "500",
      ITERM_DATABASE_URL: connectionString,
      ITERM_RUNTIME_CAPACITY_WEIGHT: capacityWeight.toString(),
      ITERM_RUNTIME_OWNER_ID: ownerId,
      ITERM_RUNTIME_OWNER_INSTANCE_ID: instanceId,
      ITERM_RUNTIME_OWNER_LEASE_MS: "2000",
      ITERM_RUNTIME_DRAIN_TIMEOUT_MS: "5000",
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
    connectionString = databaseUrl ?? "",
    databaseStatementTimeoutMilliseconds?: number,
    waitForDatabaseReady = true,
  ): Promise<ManagedChild> {
    const child = startChild(
      failpoint === undefined ? "router" : `router-${failpoint}`,
      failpoint === undefined
        ? "apps/runtime-router/src/main.ts"
        : "apps/runtime-router/src/fixtures/crash-router.ts",
      {
        ITERM_DATABASE_HEALTH_CHECK_MS: "100",
        ITERM_DATABASE_RECONNECT_INITIAL_MS: "50",
        ITERM_DATABASE_RECONNECT_MAX_MS: "50",
        ITERM_DATABASE_URL: connectionString,
        ITERM_ROUTER_SOCKET: socketPath,
        ...(databaseStatementTimeoutMilliseconds === undefined
          ? {}
          : {
              ITERM_DATABASE_STATEMENT_TIMEOUT_MS: databaseStatementTimeoutMilliseconds.toString(),
            }),
        ...(failpoint === undefined ? {} : { ITERM_TEST_FAILPOINT: failpoint }),
      },
    );
    await waitForText(child, "Runtime Router listening", 15_000);
    if (failpoint === undefined && waitForDatabaseReady) {
      await waitForText(child, "Runtime Router PostgreSQL ready", 15_000);
    }
    return child;
  }

  function startChild(
    label: string,
    entrypoint: string,
    environment: Readonly<Record<string, string>>,
  ): ManagedChild {
    const child = spawn(process.execPath, ["--import", "tsx", join(repositoryRoot, entrypoint)], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ITERM_RPC_TEST_ALLOW_UNAUTHENTICATED: "1",
        NODE_ENV: "test",
        ...environment,
      },
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
    capabilities: ACTOR_CAPABILITY_PROFILES.agent,
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

async function proveWeightedShells(
  client: UnixRuntimeClient,
  sessions: readonly Session[],
  prefix: string,
): Promise<void> {
  for (const ownerId of Object.keys(ownerCounts(sessions)).sort()) {
    const session = sessions.find((candidate) => candidate.ownerId === ownerId);
    if (session === undefined) throw new Error(`Weighted Session is missing for ${ownerId}`);
    const marker = `${prefix}-${ownerId}`;
    const execution = await client.startExecute({
      actor: actor(marker),
      command: `printf ${marker}`,
      idempotencyKey: `${marker}-execute`,
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    expect((await client.waitExecution(execution.execution.id)).output).toContain(marker);
  }
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
