import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { RuntimeError, type Session } from "@iterminal/domain";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

type RollingProfile = "high" | "smoke" | "soak";

interface RollingConfiguration {
  readonly durationMilliseconds?: number;
  readonly minimumRotations: number;
  readonly ownerCount: number;
  readonly profile: RollingProfile;
  readonly waveSessions: number;
}

interface ManagedChild {
  readonly label: string;
  readonly process: ChildProcessWithoutNullStreams;
  guardianPid?: number;
  stderr: string;
}

interface QuiescentCounts {
  readonly live_session_count: string;
  readonly open_lease_count: string;
  readonly unfinished_request_count: string;
}

const databaseUrl = process.env.ITERM_DATABASE_URL;
const selectedProfile = rollingProfile(process.env.ITERM_M9_ROLLING_PROFILE);
const configuration = rollingConfiguration(selectedProfile ?? "smoke");
const describeRolling =
  databaseUrl === undefined || selectedProfile === undefined ? describe.skip : describe;
const repositoryRoot = resolve(import.meta.dirname, "../../..");

describeRolling(`M9 high-cardinality rolling ${configuration.profile}`, () => {
  const children: ManagedChild[] = [];
  const fixtures: string[] = [];
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on("error", () => undefined);

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M9 rolling tests refuse to mutate any database except iterminal_test");
    }
    const migrator = new PostgresRuntimeDurability(databaseUrl ?? "");
    try {
      await migrator.migrate();
    } finally {
      await migrator.close();
    }
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE runtime_workers, sessions, actors, outbox RESTART IDENTITY CASCADE");
    await pool.query(
      `UPDATE session_creation_policies
          SET retention_milliseconds = 86400000,
              max_requests = 1000000,
              cleanup_batch_size = 1000,
              updated_at = now()
        WHERE scope = 'default'`,
    );
  });

  afterEach(async () => {
    for (const child of children.reverse()) await stopChild(child);
    children.length = 0;
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  afterAll(async () => pool.end());

  it(
    "preserves exact creation, fencing, fairness, progress, and bounded resources",
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "itm9-rolling-scale-")));
      fixtures.push(root);
      const workspace = join(root, "workspace");
      await mkdir(workspace, { recursive: true });
      const ownerIds = Array.from(
        { length: configuration.ownerCount },
        (_, index) => `owner-scale-${index.toString().padStart(2, "0")}`,
      );
      const ownerSockets = new Map(
        ownerIds.map((ownerId, index) => [ownerId, join(root, `owner-${index.toString()}.sock`)]),
      );
      const incarnations = new Map(ownerIds.map((ownerId) => [ownerId, 1]));
      const activeOwners = new Map<string, ManagedChild>();
      const initialOwners = await Promise.all(
        ownerIds.map((ownerId) =>
          startRuntime(root, ownerId, 1, requiredValue(ownerSockets, ownerId, "owner socket")),
        ),
      );
      children.push(...initialOwners);
      for (const [index, owner] of initialOwners.entries()) {
        activeOwners.set(requiredItem(ownerIds, index, "owner ID"), owner);
      }
      const routerSocket = join(root, "router.sock");
      const router = await startRouter(routerSocket);
      children.push(router);
      const client = new UnixRuntimeClient(routerSocket);
      const settledSessionIds = new Set<string>();
      const createLatencies: number[] = [];
      const rotationLatencies: number[] = [];
      let totalSessions = 0;
      let maximumDatabaseConnections = 0;

      const warmup = await createWave(
        client,
        pool,
        workspace,
        "warmup",
        configuration.ownerCount * 2,
        createLatencies,
        (count) => {
          maximumDatabaseConnections = Math.max(maximumDatabaseConnections, count);
        },
      );
      recordSessions(warmup, settledSessionIds);
      totalSessions += warmup.length;
      expect(ownerCounts(warmup)).toEqual(
        Object.fromEntries(ownerIds.map((ownerId) => [ownerId, 2])),
      );
      await proveEveryOwnerShell(client, warmup, "warmup");
      await closeSessions(client, warmup);
      await waitForDatabaseQuiescence(pool);
      const baselineRssKilobytes = totalRssKilobytes(activeOwners.values());
      let maximumRssKilobytes = baselineRssKilobytes;

      const rotationStartedAt = performance.now();
      const durationDeadline =
        configuration.durationMilliseconds === undefined
          ? undefined
          : rotationStartedAt + configuration.durationMilliseconds;
      let rotation = 0;
      while (
        rotation < configuration.minimumRotations ||
        (durationDeadline !== undefined && performance.now() < durationDeadline)
      ) {
        const targetOwnerId = requiredItem(ownerIds, rotation % ownerIds.length, "rotation owner");
        const target = requiredValue(activeOwners, targetOwnerId, "active owner");
        const startedAt = performance.now();
        const wavePromise = createWave(
          client,
          pool,
          workspace,
          `rotation-${rotation.toString()}`,
          configuration.waveSessions,
          createLatencies,
          (count) => {
            maximumDatabaseConnections = Math.max(maximumDatabaseConnections, count);
          },
        );
        await delay(10);
        expect(target.process.kill("SIGTERM")).toBe(true);
        const wave = await wavePromise;
        recordSessions(wave, settledSessionIds);
        totalSessions += wave.length;
        await waitForText(target, "Runtime drain settled pending_session_creations=0", 20_000);
        await waitForExit(target, 20_000);
        expect(target.process.exitCode).toBe(0);
        if (target.guardianPid === undefined) throw new Error("Target Guardian PID is missing");
        await waitUntilProcessGone(target.guardianPid, 5_000);
        await waitForOwnerStatus(pool, targetOwnerId, "STOPPED", 10_000);
        const unfinished = await pool.query(
          `SELECT 1 FROM session_creation_requests
            WHERE owner_id = $1 AND session_id IS NULL`,
          [targetOwnerId],
        );
        expect(unfinished.rowCount).toBe(0);

        const healthy = wave.find((session) => session.ownerId !== targetOwnerId);
        if (healthy === undefined) {
          throw new Error(`Rotation ${rotation.toString()} has no healthy-owner Session`);
        }
        const marker = `m9-scale-${rotation.toString()}`;
        const execution = await client.startExecute({
          actor: actor(marker),
          command: `printf ${marker}`,
          idempotencyKey: `${marker}-execute`,
          sessionGeneration: healthy.generation,
          sessionId: healthy.id,
        });
        expect((await client.waitExecution(execution.execution.id)).output).toContain(marker);
        await closeSessions(
          client,
          wave.filter((session) => session.ownerId !== targetOwnerId),
        );
        await waitForDatabaseQuiescence(pool);

        const previousIncarnation = requiredValue(incarnations, targetOwnerId, "incarnation");
        const nextIncarnation = previousIncarnation + 1;
        const replacement = await startRuntime(
          root,
          targetOwnerId,
          nextIncarnation,
          requiredValue(ownerSockets, targetOwnerId, "owner socket"),
        );
        children.push(replacement);
        activeOwners.set(targetOwnerId, replacement);
        incarnations.set(targetOwnerId, nextIncarnation);
        await expectOwnerIncarnation(pool, targetOwnerId, nextIncarnation);
        assertActiveProcesses(activeOwners.values());
        maximumDatabaseConnections = Math.max(
          maximumDatabaseConnections,
          await databaseConnectionCount(pool),
        );
        maximumRssKilobytes = Math.max(
          maximumRssKilobytes,
          totalRssKilobytes(activeOwners.values()),
        );
        rotationLatencies.push(performance.now() - startedAt);
        rotation += 1;
      }

      const placementBeforeReconciliation = await placementCounts(pool);
      const maximumPlacement = Math.max(...placementBeforeReconciliation.values());
      const reconciliationCount = [...placementBeforeReconciliation.values()].reduce(
        (total, placementCount) => total + maximumPlacement - placementCount,
        0,
      );
      if (reconciliationCount > 0) {
        const reconciliation = await createWave(
          client,
          pool,
          workspace,
          "reconciliation",
          reconciliationCount,
          createLatencies,
          (count) => {
            maximumDatabaseConnections = Math.max(maximumDatabaseConnections, count);
          },
        );
        recordSessions(reconciliation, settledSessionIds);
        totalSessions += reconciliation.length;
        await closeSessions(client, reconciliation);
        await waitForDatabaseQuiescence(pool);
      }

      const finalPlacement = await placementCounts(pool);
      expect(new Set(finalPlacement.values()).size).toBe(1);
      const durable = await pool.query<{
        bound_session_count: string;
        live_session_count: string;
        open_lease_count: string;
        request_count: string;
        unfinished_count: string;
      }>(
        `SELECT count(*)::text AS request_count,
                count(DISTINCT request.session_id)::text AS bound_session_count,
                count(*) FILTER (WHERE request.session_id IS NULL)::text AS unfinished_count,
                (SELECT count(*)::text FROM sessions WHERE status <> 'CLOSED') AS live_session_count,
                (SELECT count(*)::text FROM session_leases WHERE released_at IS NULL) AS open_lease_count
           FROM session_creation_requests AS request`,
      );
      expect(durable.rows).toEqual([
        {
          bound_session_count: totalSessions.toString(),
          live_session_count: "0",
          open_lease_count: "0",
          request_count: totalSessions.toString(),
          unfinished_count: "0",
        },
      ]);
      expect(settledSessionIds.size).toBe(totalSessions);

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
        ownerIds.map((ownerId) => {
          const incarnation = requiredValue(incarnations, ownerId, "final incarnation");
          return {
            instance_id: `instance-${ownerId}-${incarnation.toString()}`,
            owner_id: ownerId,
            registry_epoch: incarnation.toString(),
            status: "ACTIVE",
          };
        }),
      );
      const finalRssKilobytes = totalRssKilobytes(activeOwners.values());
      expect(finalRssKilobytes).toBeLessThanOrEqual(
        baselineRssKilobytes + configuration.ownerCount * 64 * 1024,
      );
      expect(maximumRssKilobytes).toBeLessThanOrEqual(
        baselineRssKilobytes + configuration.ownerCount * 128 * 1024,
      );
      expect(maximumDatabaseConnections).toBeLessThanOrEqual(configuration.ownerCount * 10 + 10);

      const elapsedMilliseconds = Math.round(performance.now() - rotationStartedAt);
      process.stdout.write(
        `M9_ROLLING_RESULT ${JSON.stringify({
          baselineRssKilobytes,
          createLatencyP95Milliseconds: percentile(createLatencies, 0.95),
          elapsedMilliseconds,
          finalRssKilobytes,
          maximumDatabaseConnections,
          maximumRssKilobytes,
          ownerCount: configuration.ownerCount,
          profile: configuration.profile,
          rotationCount: rotation,
          rotationLatencyP95Milliseconds: percentile(rotationLatencies, 0.95),
          totalSessions,
          waveSessions: configuration.waveSessions,
        })}\n`,
      );

      await Promise.all(
        [...activeOwners.values()].map(async (owner) => {
          expect(owner.process.kill("SIGTERM")).toBe(true);
          await waitForExit(owner, 20_000);
          expect(owner.process.exitCode).toBe(0);
          if (owner.guardianPid === undefined) throw new Error("Final Guardian PID is missing");
          await waitUntilProcessGone(owner.guardianPid, 5_000);
        }),
      );
      const stopped = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM runtime_workers WHERE status = 'STOPPED'",
      );
      expect(stopped.rows).toEqual([{ count: configuration.ownerCount.toString() }]);
    },
    testTimeoutMilliseconds(configuration),
  );
});

function rollingProfile(value: string | undefined): RollingProfile | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "smoke" || value === "high" || value === "soak") return value;
  throw new Error("ITERM_M9_ROLLING_PROFILE must be smoke, high, or soak");
}

function rollingConfiguration(profile: RollingProfile): RollingConfiguration {
  if (profile === "smoke") {
    return { minimumRotations: 6, ownerCount: 6, profile, waveSessions: 18 };
  }
  if (profile === "high") {
    return { minimumRotations: 16, ownerCount: 8, profile, waveSessions: 32 };
  }
  return {
    durationMilliseconds: positiveEnvironmentInteger(
      "ITERM_M9_SOAK_DURATION_MS",
      30 * 60 * 1_000,
      60_000,
      24 * 60 * 60 * 1_000,
    ),
    minimumRotations: positiveEnvironmentInteger("ITERM_M9_SOAK_MIN_ROTATIONS", 16, 8, 100_000),
    ownerCount: positiveEnvironmentInteger("ITERM_M9_SOAK_OWNER_COUNT", 8, 3, 16),
    profile,
    waveSessions: positiveEnvironmentInteger("ITERM_M9_SOAK_WAVE_SESSIONS", 32, 3, 128),
  };
}

function positiveEnvironmentInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum.toString()} through ${maximum.toString()}`,
    );
  }
  return value;
}

function testTimeoutMilliseconds(configuration: RollingConfiguration): number {
  return Math.max(10 * 60 * 1_000, (configuration.durationMilliseconds ?? 0) + 10 * 60 * 1_000);
}

async function startRuntime(
  root: string,
  ownerId: string,
  incarnation: number,
  socketPath: string,
): Promise<ManagedChild> {
  const child = startChild(
    `runtime-${ownerId}-${incarnation.toString()}`,
    "apps/runtime-daemon/src/main.ts",
    {
      ITERM_DATABASE_HEALTH_CHECK_MS: "100",
      ITERM_DATABASE_RECONNECT_INITIAL_MS: "50",
      ITERM_DATABASE_RECONNECT_MAX_MS: "50",
      ITERM_DATABASE_STATEMENT_TIMEOUT_MS: "5000",
      ITERM_DATABASE_URL: databaseUrl ?? "",
      ITERM_RUNTIME_DRAIN_TIMEOUT_MS: "10000",
      ITERM_RUNTIME_OWNER_ID: ownerId,
      ITERM_RUNTIME_OWNER_INSTANCE_ID: `instance-${ownerId}-${incarnation.toString()}`,
      ITERM_RUNTIME_OWNER_LEASE_MS: "4000",
      ITERM_RUNTIME_SOCKET: socketPath,
      ITERM_SESSION_LEASE_MS: "4000",
      TMPDIR: root,
    },
  );
  await waitForText(child, "Runtime PostgreSQL ready", 20_000);
  await waitForText(child, "Runtime Process Guardian ready", 20_000);
  child.guardianPid = integerFromLog(child.stderr, /Process Guardian ready pid=(\d+)/u);
  expectProcessPresent(child.guardianPid);
  return child;
}

async function startRouter(socketPath: string): Promise<ManagedChild> {
  const child = startChild("router-scale", "apps/runtime-router/src/main.ts", {
    ITERM_DATABASE_HEALTH_CHECK_MS: "100",
    ITERM_DATABASE_RECONNECT_INITIAL_MS: "50",
    ITERM_DATABASE_RECONNECT_MAX_MS: "50",
    ITERM_DATABASE_STATEMENT_TIMEOUT_MS: "5000",
    ITERM_DATABASE_URL: databaseUrl ?? "",
    ITERM_ROUTER_SOCKET: socketPath,
  });
  await waitForText(child, "Runtime Router PostgreSQL ready", 20_000);
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

async function createWave(
  client: UnixRuntimeClient,
  pool: Pool,
  workspaceRoot: string,
  prefix: string,
  count: number,
  latencies: number[],
  observeDatabaseConnections: (count: number) => void,
): Promise<readonly Session[]> {
  const startedAt = performance.now();
  const sampling = { active: true };
  const sampler = (async (): Promise<void> => {
    while (sampling.active) {
      await databaseConnectionCount(pool)
        .then(observeDatabaseConnections)
        .catch(() => undefined);
      await delay(10);
    }
  })();
  try {
    const sessions = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        createSessionWithRetry(client, {
          idempotencyKey: `m9-scale-${prefix}-${index.toString()}`,
          shell: "zsh",
          workspaceRoot,
        }),
      ),
    );
    latencies.push(performance.now() - startedAt);
    return sessions;
  } finally {
    sampling.active = false;
    await sampler;
  }
}

async function createSessionWithRetry(
  client: UnixRuntimeClient,
  request: Readonly<{
    idempotencyKey: string;
    shell: "zsh";
    workspaceRoot: string;
  }>,
): Promise<Session> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await client.createSession(request);
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof RuntimeError) ||
        (!error.retryable && error.code !== "DELIVERY_UNKNOWN")
      ) {
        throw error;
      }
      await delay(50);
    }
  }
  throw new Error(
    `Timed out settling root creation ${request.idempotencyKey}: ${errorMessage(lastError)}`,
  );
}

function recordSessions(sessions: readonly Session[], settledSessionIds: Set<string>): void {
  for (const session of sessions) {
    expect(settledSessionIds.has(session.id)).toBe(false);
    settledSessionIds.add(session.id);
  }
}

async function proveEveryOwnerShell(
  client: UnixRuntimeClient,
  sessions: readonly Session[],
  prefix: string,
): Promise<void> {
  for (const ownerId of Object.keys(ownerCounts(sessions)).sort()) {
    const session = sessions.find((candidate) => candidate.ownerId === ownerId);
    if (session === undefined) throw new Error(`Session is missing for ${ownerId}`);
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

async function closeSessions(
  client: UnixRuntimeClient,
  sessions: readonly Session[],
): Promise<void> {
  await Promise.all(sessions.map((session) => client.closeSession(session.id, session.generation)));
}

function ownerCounts(sessions: readonly Session[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const session of sessions) counts[session.ownerId] = (counts[session.ownerId] ?? 0) + 1;
  return counts;
}

function actor(id: string) {
  return {
    client: "m9-high-cardinality-rolling-test",
    id,
    principal: id,
    capabilities: ACTOR_CAPABILITY_PROFILES.agent,
    type: "agent" as const,
  };
}

async function waitForDatabaseQuiescence(pool: Pool): Promise<void> {
  await waitFor(
    async () => {
      const result = await pool.query<QuiescentCounts>(
        `SELECT (SELECT count(*)::text FROM sessions WHERE status <> 'CLOSED') AS live_session_count,
              (SELECT count(*)::text FROM session_leases WHERE released_at IS NULL) AS open_lease_count,
              (SELECT count(*)::text FROM session_creation_requests WHERE session_id IS NULL)
                AS unfinished_request_count`,
      );
      const row = result.rows[0];
      return (
        row?.live_session_count === "0" &&
        row.open_lease_count === "0" &&
        row.unfinished_request_count === "0"
      );
    },
    15_000,
    "durable Session/lease/request quiescence",
  );
}

async function expectOwnerIncarnation(
  pool: Pool,
  ownerId: string,
  incarnation: number,
): Promise<void> {
  const result = await pool.query<{
    instance_id: string;
    registry_epoch: string;
    status: string;
  }>(
    `SELECT instance_id, registry_epoch::text, status
       FROM runtime_workers WHERE owner_id = $1`,
    [ownerId],
  );
  expect(result.rows).toEqual([
    {
      instance_id: `instance-${ownerId}-${incarnation.toString()}`,
      registry_epoch: incarnation.toString(),
      status: "ACTIVE",
    },
  ]);
}

async function waitForOwnerStatus(
  pool: Pool,
  ownerId: string,
  status: string,
  timeoutMilliseconds: number,
): Promise<void> {
  await waitFor(
    async () => {
      const result = await pool.query<{ status: string }>(
        "SELECT status FROM runtime_workers WHERE owner_id = $1",
        [ownerId],
      );
      return result.rows[0]?.status === status;
    },
    timeoutMilliseconds,
    `owner ${ownerId} status ${status}`,
  );
}

async function placementCounts(pool: Pool): Promise<Map<string, number>> {
  const result = await pool.query<{ owner_id: string; placement_count: string }>(
    "SELECT owner_id, placement_count::text FROM runtime_workers ORDER BY owner_id",
  );
  return new Map(
    result.rows.map((row) => [row.owner_id, Number.parseInt(row.placement_count, 10)]),
  );
}

async function databaseConnectionCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend'`,
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
}

function assertActiveProcesses(children: Iterable<ManagedChild>): void {
  for (const child of children) {
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      throw new Error(`${child.label} exited unexpectedly: ${child.stderr}`);
    }
    if (child.guardianPid === undefined) throw new Error(`${child.label} Guardian PID is missing`);
    expectProcessPresent(child.guardianPid);
  }
}

function totalRssKilobytes(children: Iterable<ManagedChild>): number {
  let total = 0;
  for (const child of children) {
    const pid = child.process.pid;
    if (pid === undefined) throw new Error(`${child.label} PID is missing`);
    total += processRssKilobytes(pid);
    if (child.guardianPid === undefined) throw new Error(`${child.label} Guardian PID is missing`);
    total += processRssKilobytes(child.guardianPid);
  }
  return total;
}

function processRssKilobytes(pid: number): number {
  const value = execFileSync("ps", ["-o", "rss=", "-p", pid.toString()], {
    encoding: "utf8",
    timeout: 2_000,
  }).trim();
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`RSS is unavailable for PID ${pid.toString()}`);
  }
  return parsed;
}

function expectProcessPresent(pid: number): void {
  expect(() => process.kill(pid, 0)).not.toThrow();
}

async function waitUntilProcessGone(pid: number, timeoutMilliseconds: number): Promise<void> {
  await waitFor(
    () => {
      try {
        process.kill(pid, 0);
        return Promise.resolve(false);
      } catch (error) {
        if (isNodeError(error, "ESRCH")) return Promise.resolve(true);
        throw error;
      }
    },
    timeoutMilliseconds,
    `process ${pid.toString()} exit`,
  );
}

async function waitForText(
  child: ManagedChild,
  expected: string,
  timeoutMilliseconds: number,
): Promise<void> {
  await waitFor(
    () => {
      if (child.stderr.includes(expected)) return Promise.resolve(true);
      if (child.process.exitCode !== null || child.process.signalCode !== null) {
        throw new Error(`${child.label} exited before ${expected}: ${child.stderr}`);
      }
      return Promise.resolve(false);
    },
    timeoutMilliseconds,
    `${child.label} text ${expected}`,
  );
}

async function waitForExit(child: ManagedChild, timeoutMilliseconds: number): Promise<void> {
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

async function stopChild(child: ManagedChild): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  child.process.kill("SIGTERM");
  try {
    await waitForExit(child, 10_000);
  } catch {
    child.process.kill("SIGKILL");
    await waitForExit(child, 5_000);
  }
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMilliseconds: number,
  label: string,
): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMilliseconds) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError === undefined ? "" : `: ${errorMessage(lastError)}`}`,
  );
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return Math.round(requiredItem(sorted, index, "percentile"));
}

function integerFromLog(value: string, pattern: RegExp): number {
  const parsed = Number.parseInt(pattern.exec(value)?.[1] ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 1) {
    throw new Error(`Expected a positive PID in Runtime log: ${value}`);
  }
  return parsed;
}

function requiredItem<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`${label} is missing at index ${index.toString()}`);
  return value;
}

function requiredValue<K, V>(values: ReadonlyMap<K, V>, key: K, label: string): V {
  const value = values.get(key);
  if (value === undefined) throw new Error(`${label} is missing for ${String(key)}`);
  return value;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
