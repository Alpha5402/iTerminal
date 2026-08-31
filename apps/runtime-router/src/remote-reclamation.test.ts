import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const repositoryRoot = resolve(import.meta.dirname, "../../..");

interface ManagedChild {
  readonly label: string;
  readonly process: ChildProcessWithoutNullStreams;
  stderr: string;
}

describeDatabase("M9.17 host-local remote Runtime reclamation", () => {
  const children: ManagedChild[] = [];
  const fixtures: string[] = [];
  const stoppedChildren = new Set<ManagedChild>();
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on("error", () => undefined);

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M9.17 refuses to mutate any database except iterminal_test");
    }
    const migrator = new PostgresRuntimeDurability(
      databaseUrl ?? "postgresql://localhost/iterminal_test",
    );
    try {
      await migrator.migrate();
    } finally {
      await migrator.close();
    }
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

  afterAll(async () => {
    for (const child of stoppedChildren) child.process.kill("SIGCONT");
    stoppedChildren.clear();
    for (const child of children.reverse()) await stopChild(child);
    for (const fixture of fixtures) await rm(fixture, { force: true, recursive: true });
    await pool.end();
  });

  it("reclaims the old host process tree before replacement owner recovery", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "itm9-remote-reclaim-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    const delayedEffect = join(root, "delayed-effect.txt");
    const startedFile = join(root, "started.txt");
    const recoveredEffect = join(root, "recovered.txt");
    const oldSocket = join(root, "runtime-old.sock");
    const replacementSocket = join(root, "runtime-replacement.sock");
    const routerSocket = join(root, "router.sock");
    await mkdir(workspace, { recursive: true });

    const oldRuntime = startRuntime("old-runtime", oldSocket, "instance-old", databaseUrl ?? "");
    children.push(oldRuntime);
    const router = startChild("router", "apps/runtime-router/src/main.ts", {
      ITERM_DATABASE_HEALTH_CHECK_MS: "50",
      ITERM_DATABASE_RECONNECT_INITIAL_MS: "25",
      ITERM_DATABASE_RECONNECT_MAX_MS: "50",
      ITERM_DATABASE_URL: databaseUrl ?? "",
      ITERM_ROUTER_SOCKET: routerSocket,
    });
    children.push(router);
    await waitForText(oldRuntime, "Runtime PostgreSQL ready", 20_000);
    await waitForText(oldRuntime, "Runtime Process Guardian ready", 20_000);
    await waitForText(router, "Router PostgreSQL ready", 20_000);

    const guardianPid = integerFromLog(oldRuntime.stderr, /Process Guardian ready pid=(\d+)/u);
    expectProcessPresent(guardianPid);
    const client = new UnixRuntimeClient(routerSocket);
    const session = await client.createSession({
      idempotencyKey: "m917-old-session",
      shell: "zsh",
      workspaceRoot: workspace,
    });
    const running = await client.startExecute({
      actor: actor("old-owner"),
      command: `printf 'started\\n' > ${shellQuote(startedFile)}; (sleep 2; printf 'escaped\\n' >> ${shellQuote(delayedEffect)}) & sleep 30`,
      idempotencyKey: "m917-old-execution",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await waitForFile(startedFile, "started\n");
    await waitForExecutionStatus(client, running.execution.id, "RUNNING");
    const shell = await pool.query<{ shell_pid: number }>(
      `SELECT shell_pid
         FROM session_generations
        WHERE session_id = $1 AND generation = $2`,
      [session.id, session.generation],
    );
    const shellPid = shell.rows[0]?.shell_pid;
    if (shellPid === undefined) throw new Error("M9.17 Shell PID is missing");

    oldRuntime.process.kill("SIGSTOP");
    stoppedChildren.add(oldRuntime);
    expectProcessPresent(guardianPid);
    await waitUntilProcessInactive(shellPid, 5_000).catch((error: unknown) => {
      throw new Error(
        `${errorMessage(error)}; guardian_state=${processState(guardianPid) ?? "missing"}; runtime_log=${oldRuntime.stderr}`,
      );
    });
    expectProcessPresent(guardianPid);
    await delay(2_200);
    expect(await readOptional(delayedEffect)).toBe("");

    const replacement = startRuntime(
      "replacement-runtime",
      replacementSocket,
      "instance-replacement",
      databaseUrl ?? "",
    );
    children.push(replacement);
    await waitForText(replacement, "Runtime PostgreSQL ready", 20_000);
    await waitForText(replacement, "Runtime Process Guardian ready", 20_000);
    const replacementPid = replacement.process.pid;
    if (replacementPid === undefined) throw new Error("M9.17 replacement PID is missing");

    const durable = await pool.query<{
      execution_status: string;
      owner_instance_id: string;
      owner_registry_epoch: string;
      session_status: string;
    }>(
      `SELECT s.status AS session_status,
              e.status AS execution_status,
              w.instance_id AS owner_instance_id,
              w.registry_epoch::text AS owner_registry_epoch
         FROM sessions s
         JOIN executions e ON e.session_id = s.id
         JOIN runtime_workers w ON w.owner_id = s.owner_id
        WHERE s.id = $1 AND e.id = $2`,
      [session.id, running.execution.id],
    );
    expect(durable.rows).toEqual([
      {
        execution_status: "UNKNOWN",
        owner_instance_id: "instance-replacement",
        owner_registry_epoch: "2",
        session_status: "BROKEN",
      },
    ]);

    const recovered = await client.createSession({
      idempotencyKey: "m917-recovered-session",
      shell: "zsh",
      workspaceRoot: workspace,
    });
    const recoveredExecution = await client.startExecute({
      actor: actor("replacement-owner"),
      command: `printf 'recovered\\n' > ${shellQuote(recoveredEffect)}`,
      idempotencyKey: "m917-recovered-execution",
      sessionGeneration: recovered.generation,
      sessionId: recovered.id,
    });
    expect((await client.waitExecution(recoveredExecution.execution.id)).status).toBe("COMPLETED");
    expect(await readFile(recoveredEffect, "utf8")).toBe("recovered\n");
    expect(recovered.id).not.toBe(session.id);

    oldRuntime.process.kill("SIGCONT");
    stoppedChildren.delete(oldRuntime);
    await waitForText(oldRuntime, "Process Guardian reclaimed reason=lease_timeout", 10_000);
    await waitForText(oldRuntime, "Runtime PostgreSQL unavailable", 10_000);
    expect(oldRuntime.process.pid).not.toBe(replacementPid);
    await stopChild(oldRuntime);
    await waitUntilProcessGone(shellPid, 5_000);
    await waitUntilProcessGone(guardianPid, 5_000);
    await client.closeSession(recovered.id, recovered.generation);
  }, 60_000);
});

function startRuntime(
  label: string,
  socketPath: string,
  instanceId: string,
  connectionString: string,
): ManagedChild {
  return startChild(label, "apps/runtime-daemon/src/main.ts", {
    ITERM_DATABASE_HEALTH_CHECK_MS: "50",
    ITERM_DATABASE_RECONNECT_INITIAL_MS: "25",
    ITERM_DATABASE_RECONNECT_MAX_MS: "50",
    ITERM_DATABASE_URL: connectionString,
    ITERM_RUNTIME_GUARDIAN_TERMINATION_GRACE_MS: "100",
    ITERM_RUNTIME_OWNER_ID: "owner-remote-reclamation",
    ITERM_RUNTIME_OWNER_INSTANCE_ID: instanceId,
    ITERM_RUNTIME_OWNER_LEASE_MS: "1000",
    ITERM_RUNTIME_SOCKET: socketPath,
    ITERM_SESSION_LEASE_MS: "1000",
  });
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
  await waitFor(async () => (await readOptional(path)) === expected, 10_000, `file ${path}`);
}

async function waitForText(
  child: ManagedChild,
  expected: string,
  timeoutMilliseconds: number,
): Promise<void> {
  try {
    await waitFor(
      () => {
        if (child.process.exitCode !== null || child.process.signalCode !== null) {
          throw new Error(`${child.label} exited before ${expected}`);
        }
        return Promise.resolve(child.stderr.includes(expected));
      },
      timeoutMilliseconds,
      `${child.label} text ${expected}`,
    );
  } catch (error) {
    throw new Error(`${errorMessage(error)}; ${child.label}_log=${child.stderr}`, {
      cause: error,
    });
  }
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

async function waitUntilProcessInactive(pid: number, timeoutMilliseconds: number): Promise<void> {
  const startedAt = Date.now();
  let state: string | undefined;
  while (Date.now() - startedAt < timeoutMilliseconds) {
    state = processState(pid);
    if (state === undefined || state.startsWith("Z") || state.includes("E")) return;
    await delay(25);
  }
  throw new Error(
    `Timed out waiting for process ${pid.toString()} to become absent, zombie, or exiting; state=${state ?? "missing"}`,
  );
}

function processState(pid: number): string | undefined {
  try {
    const state = execFileSync("ps", ["-o", "state=", "-p", pid.toString()], {
      encoding: "utf8",
      timeout: 2_000,
    }).trim();
    return state === "" ? undefined : state;
  } catch {
    return undefined;
  }
}

function expectProcessPresent(pid: number): void {
  expect(() => process.kill(pid, 0)).not.toThrow();
}

async function stopChild(child: ManagedChild): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  child.process.kill("SIGTERM");
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

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return "";
    throw error;
  }
}

function integerFromLog(value: string, pattern: RegExp): number {
  const match = pattern.exec(value);
  const parsed = Number.parseInt(match?.[1] ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 1) {
    throw new Error(`Expected a positive PID in Runtime log: ${value}`);
  }
  return parsed;
}

function actor(id: string) {
  return {
    client: "m9-remote-reclamation-test",
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
  return error instanceof Error ? error.message : String(error);
}
