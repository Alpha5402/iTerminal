import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const clusterUrls = commaSeparated("ITERM_TEST_POSTGRES_QUORUM_URLS");
const clusterContainers = commaSeparated("ITERM_TEST_POSTGRES_QUORUM_CONTAINERS");
const describeQuorum =
  clusterUrls.length === 3 && clusterContainers.length === 3 ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const execFileAsync = promisify(execFile);

interface ManagedChild {
  readonly label: string;
  readonly process: ChildProcessWithoutNullStreams;
  stderr: string;
}

describeQuorum("M9.16 PostgreSQL quorum primary failover", () => {
  const children: ManagedChild[] = [];
  const fixtures: string[] = [];

  beforeAll(async () => {
    const migrator = new PostgresRuntimeDurability(clusterUrls);
    try {
      await migrator.migrate();
    } finally {
      await migrator.close();
    }
  });

  afterAll(async () => {
    for (const child of children.reverse()) await stopChild(child, "SIGTERM");
    for (const fixture of fixtures) await rm(fixture, { force: true, recursive: true });
  });

  it("fails a reachable minority closed, then follows an externally promoted majority primary", async () => {
    const [primaryUrl, promotedUrl] = clusterUrls;
    const [primaryContainer, promotedContainer, followerContainer] = clusterContainers;
    if (
      primaryUrl === undefined ||
      promotedUrl === undefined ||
      primaryContainer === undefined ||
      promotedContainer === undefined ||
      followerContainer === undefined
    ) {
      throw new Error("M9.16 requires three PostgreSQL URLs and containers");
    }

    const primary = guardedPool(primaryUrl);
    let promoted: Pool | undefined;
    let standbysPaused = false;
    let formerPrimaryStopped = false;
    const root = await realpath(await mkdtemp(join("/private/tmp", "itm9-pg-quorum-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    const sideEffect = join(root, "side-effect.txt");
    const runtimeSocket = join(root, "runtime.sock");
    const routerSocket = join(root, "router.sock");
    await mkdir(workspace, { recursive: true });

    try {
      const database = await primary.query<{ current_database: string }>(
        "SELECT current_database()",
      );
      expect(database.rows[0]?.current_database).toBe("iterminal_test");
      const topology = await primary.query<{
        application_name: string;
        state: string;
        sync_state: string;
      }>(
        `SELECT application_name, state, sync_state
           FROM pg_stat_replication
          ORDER BY application_name`,
      );
      expect(topology.rows).toEqual([
        { application_name: "standby1", state: "streaming", sync_state: "quorum" },
        { application_name: "standby2", state: "streaming", sync_state: "quorum" },
      ]);
      const synchronous = await primary.query<{
        synchronous_commit: string;
        synchronous_standby_names: string;
      }>(
        `SELECT current_setting('synchronous_commit') AS synchronous_commit,
                current_setting('synchronous_standby_names') AS synchronous_standby_names`,
      );
      expect(synchronous.rows).toEqual([
        {
          synchronous_commit: "remote_apply",
          synchronous_standby_names: "ANY 1 (standby1, standby2)",
        },
      ]);
      await primary.query(
        "TRUNCATE runtime_workers, sessions, actors, outbox RESTART IDENTITY CASCADE",
      );

      const runtime = startChild("runtime", "apps/runtime-daemon/src/main.ts", {
        ITERM_DATABASE_HEALTH_CHECK_MS: "100",
        ITERM_DATABASE_RECONNECT_INITIAL_MS: "50",
        ITERM_DATABASE_RECONNECT_MAX_MS: "100",
        ITERM_DATABASE_STATEMENT_TIMEOUT_MS: "500",
        ITERM_DATABASE_URLS: clusterUrls.join(","),
        ITERM_RUNTIME_OWNER_ID: "owner-postgres-quorum",
        ITERM_RUNTIME_OWNER_INSTANCE_ID: "instance-postgres-quorum",
        ITERM_RUNTIME_OWNER_LEASE_MS: "2000",
        ITERM_RUNTIME_SOCKET: runtimeSocket,
        ITERM_SESSION_LEASE_MS: "2000",
        TMPDIR: root,
      });
      children.push(runtime);
      const router = startChild("router", "apps/runtime-router/src/main.ts", {
        ITERM_DATABASE_HEALTH_CHECK_MS: "100",
        ITERM_DATABASE_RECONNECT_INITIAL_MS: "50",
        ITERM_DATABASE_RECONNECT_MAX_MS: "100",
        ITERM_DATABASE_STATEMENT_TIMEOUT_MS: "500",
        ITERM_DATABASE_URLS: clusterUrls.join(","),
        ITERM_ROUTER_SOCKET: routerSocket,
      });
      children.push(router);
      await waitForText(runtime, "Runtime PostgreSQL ready", 20_000);
      await waitForText(router, "Router PostgreSQL ready", 20_000);
      expect(runtime.stderr).toContain("endpoint_index=0");
      expect(router.stderr).toContain("endpoint_index=0");
      const runtimePid = runtime.process.pid;
      const routerPid = router.process.pid;
      if (runtimePid === undefined || routerPid === undefined) {
        throw new Error("M9.16 child PID is missing");
      }

      const client = new UnixRuntimeClient(routerSocket);
      const baseline = await client.createSession({
        idempotencyKey: "m916-baseline-session",
        shell: "zsh",
        workspaceRoot: workspace,
      });
      const completed = await client.startExecute({
        actor: actor("baseline"),
        command: `printf 'baseline\\n' >> ${shellQuote(sideEffect)}`,
        idempotencyKey: "m916-baseline-execute",
        sessionGeneration: baseline.generation,
        sessionId: baseline.id,
      });
      expect((await client.waitExecution(completed.execution.id)).status).toBe("COMPLETED");
      const running = await client.startExecute({
        actor: actor("running"),
        command: `printf 'once\\n' >> ${shellQuote(sideEffect)}; sleep 30; printf 'never\\n' >> ${shellQuote(sideEffect)}`,
        idempotencyKey: "m916-running-execute",
        sessionGeneration: baseline.generation,
        sessionId: baseline.id,
      });
      await waitForExecutionStatus(client, running.execution.id, "RUNNING");
      await waitForFile(sideEffect, "baseline\nonce\n");
      const shell = await primary.query<{ shell_pid: number }>(
        `SELECT shell_pid
           FROM session_generations
          WHERE session_id = $1 AND generation = $2`,
        [baseline.id, baseline.generation],
      );
      const shellPid = shell.rows[0]?.shell_pid;
      if (shellPid === undefined) throw new Error("M9.16 Shell PID is missing");

      await docker("pause", promotedContainer, followerContainer);
      standbysPaused = true;
      await waitForNewText(runtime, "Runtime PostgreSQL unavailable", 20_000);
      await waitUntilProcessGone(shellPid, 10_000);

      const minorityStartedAt = Date.now();
      await expectRuntimeCode(
        client.createSession({
          idempotencyKey: "m916-minority-session",
          shell: "zsh",
          workspaceRoot: workspace,
        }),
        "RUNTIME_UNAVAILABLE",
      );
      expect(Date.now() - minorityStartedAt).toBeLessThan(5_000);
      expect(await containerRunning(primaryContainer)).toBe(true);
      const oldPrimaryIntent = await primary.query<{ count: string }>(
        "SELECT count(*) FROM session_creation_requests WHERE idempotency_key = 'm916-minority-session'",
      );
      expect(Number.parseInt(oldPrimaryIntent.rows[0]?.count ?? "0", 10)).toBeLessThanOrEqual(1);
      await primary.end();

      await docker("stop", "--time", "1", primaryContainer);
      formerPrimaryStopped = true;
      expect(await containerRunning(primaryContainer)).toBe(false);
      await docker("unpause", promotedContainer, followerContainer);
      standbysPaused = false;
      await promote(promotedContainer);
      await reparentFollower(followerContainer);
      promoted = guardedPool(promotedUrl);
      await waitForWritablePrimary(promoted);
      await waitForFollower(promoted, "standby2");

      await waitForText(runtime, "Runtime PostgreSQL ready attempt=0 endpoint_index=1", 45_000);
      await waitForText(router, "Router PostgreSQL ready endpoint_index=1", 45_000);
      expect(runtime.process.pid).toBe(runtimePid);
      expect(router.process.pid).toBe(routerPid);
      expect(await containerRunning(primaryContainer)).toBe(false);

      const recovered = await client.createSession({
        idempotencyKey: "m916-recovered-session",
        shell: "zsh",
        workspaceRoot: workspace,
      });
      const recoveredExecution = await client.startExecute({
        actor: actor("recovered"),
        command: `printf 'recovered\\n' >> ${shellQuote(sideEffect)}`,
        idempotencyKey: "m916-recovered-execute",
        sessionGeneration: recovered.generation,
        sessionId: recovered.id,
      });
      expect((await client.waitExecution(recoveredExecution.execution.id)).status).toBe(
        "COMPLETED",
      );
      expect(await readFile(sideEffect, "utf8")).toBe("baseline\nonce\nrecovered\n");

      const durable = await promoted.query<{
        minority_intents: string;
        old_execution_status: string;
        old_session_status: string;
        recovered_session_count: string;
        session_count: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM session_creation_requests
             WHERE idempotency_key = 'm916-minority-session') AS minority_intents,
           (SELECT status FROM executions WHERE id = $1) AS old_execution_status,
           (SELECT status FROM sessions WHERE id = $2) AS old_session_status,
           (SELECT count(*)::text FROM sessions WHERE id = $3) AS recovered_session_count,
           (SELECT count(*)::text FROM sessions) AS session_count`,
        [running.execution.id, baseline.id, recovered.id],
      );
      expect(durable.rows).toEqual([
        {
          minority_intents: "0",
          old_execution_status: "UNKNOWN",
          old_session_status: "BROKEN",
          recovered_session_count: "1",
          session_count: "2",
        },
      ]);
      const owner = await promoted.query<{
        instance_id: string;
        registry_epoch: string;
        status: string;
      }>(
        `SELECT instance_id, registry_epoch::text, status
           FROM runtime_workers
          WHERE owner_id = 'owner-postgres-quorum'`,
      );
      expect(owner.rows).toEqual([
        {
          instance_id: "instance-postgres-quorum",
          registry_epoch: "1",
          status: "ACTIVE",
        },
      ]);
      await client.closeSession(recovered.id, recovered.generation);
    } finally {
      if (standbysPaused) {
        await docker("unpause", promotedContainer, followerContainer).catch(() => undefined);
      }
      if (!formerPrimaryStopped) await primary.end().catch(() => undefined);
      await promoted?.end().catch(() => undefined);
    }
  }, 180_000);
});

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

function guardedPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString });
  pool.on("error", () => undefined);
  return pool;
}

async function promote(container: string): Promise<void> {
  await docker(
    "exec",
    container,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "iterminal",
    "-d",
    "iterminal_test",
    "-c",
    "SELECT pg_promote(true, 60)",
  );
}

async function reparentFollower(container: string): Promise<void> {
  const script = [
    "set -eu",
    "sed -i '/^primary_conninfo/d' \"$PGDATA/postgresql.auto.conf\"",
    `printf "%s\\n" "primary_conninfo = 'host=postgres-standby1 port=5432 user=iterminal password=iterminal application_name=standby2'" >> "$PGDATA/postgresql.auto.conf"`,
  ].join("; ");
  await docker("exec", "--user", "postgres", container, "sh", "-c", script);
  await docker("restart", container);
  await waitFor(
    async () => {
      try {
        const result = await docker(
          "exec",
          container,
          "psql",
          "-U",
          "iterminal",
          "-d",
          "iterminal_test",
          "-Atc",
          "SELECT pg_is_in_recovery()",
        );
        return result.trim() === "t";
      } catch {
        return false;
      }
    },
    30_000,
    "reparented standby readiness",
  );
}

async function waitForWritablePrimary(pool: Pool): Promise<void> {
  await waitFor(
    async () => {
      try {
        const result = await pool.query<{ in_recovery: boolean }>(
          "SELECT pg_is_in_recovery() AS in_recovery",
        );
        return result.rows[0]?.in_recovery === false;
      } catch {
        return false;
      }
    },
    30_000,
    "promoted writable primary",
  );
}

async function waitForFollower(pool: Pool, applicationName: string): Promise<void> {
  await waitFor(
    async () => {
      const result = await pool.query<{ state: string; sync_state: string }>(
        `SELECT state, sync_state
         FROM pg_stat_replication
        WHERE application_name = $1`,
        [applicationName],
      );
      return result.rows[0]?.state === "streaming" && result.rows[0]?.sync_state === "quorum";
    },
    45_000,
    "promoted-primary synchronous follower",
  );
}

async function expectRuntimeCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected Runtime error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

async function waitForExecutionStatus(
  client: UnixRuntimeClient,
  executionId: string,
  status: string,
): Promise<void> {
  await waitFor(
    async () => (await client.getExecution(executionId)).status === status,
    10_000,
    `Execution ${executionId} status ${status}`,
  );
}

async function waitForFile(path: string, expected: string): Promise<void> {
  await waitFor(
    async () => {
      try {
        return (await readFile(path, "utf8")) === expected;
      } catch {
        return false;
      }
    },
    10_000,
    `file ${path}`,
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
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${child.label} text ${expected}: ${child.stderr}`);
}

async function waitForNewText(
  child: ManagedChild,
  expected: string,
  timeoutMilliseconds: number,
): Promise<void> {
  const before = occurrenceCount(child.stderr, expected);
  await waitFor(
    () => Promise.resolve(occurrenceCount(child.stderr, expected) > before),
    timeoutMilliseconds,
    `${child.label} new ${expected}`,
  );
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

async function stopChild(child: ManagedChild, signal: NodeJS.Signals): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  child.process.kill(signal);
  try {
    await waitFor(
      () => Promise.resolve(child.process.exitCode !== null || child.process.signalCode !== null),
      10_000,
      `${child.label} exit`,
    );
  } catch {
    child.process.kill("SIGKILL");
  }
}

async function containerRunning(container: string): Promise<boolean> {
  const state = await docker("inspect", "--format", "{{.State.Running}}", container);
  return state.trim() === "true";
}

async function docker(...args: readonly string[]): Promise<string> {
  const result = await execFileAsync("docker", [...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
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
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError === undefined ? "" : `: ${errorMessage(lastError)}`}`,
  );
}

function commaSeparated(name: string): readonly string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

function occurrenceCount(value: string, expected: string): number {
  return value.split(expected).length - 1;
}

function actor(id: string) {
  return {
    client: "m9-postgres-quorum-test",
    id,
    principal: id,
    capabilities: ACTOR_CAPABILITY_PROFILES.agent,
    type: "agent" as const,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
