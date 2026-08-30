import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const repositoryRoot = resolve(import.meta.dirname, "../../..");

describeDatabase("M4.1 durable Runtime daemon", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const clients: Client[] = [];
  const fixtures: string[] = [];
  let daemon: RuntimeDaemonHandle | undefined;
  let daemonChild: ChildProcessWithoutNullStreams | undefined;

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M4.1 tests refuse to mutate any database except iterminal_test");
    }
    const migrator = new PostgresRuntimeDurability(databaseUrl ?? "");
    await migrator.migrate();
    await migrator.close();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox RESTART IDENTITY CASCADE");
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
    if (daemonChild !== undefined && daemonChild.exitCode === null) {
      daemonChild.kill("SIGKILL");
      await waitForExit(daemonChild);
    }
    daemonChild = undefined;
    await daemon?.close().catch(() => undefined);
    daemon = undefined;
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  afterAll(async () => pool.end());

  it("persists MCP Execute/Input output and lifecycle facts before returning", async () => {
    const fixture = await createFixture();
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-m4-durable-happy",
      socketPath: join(fixture.root, "runtime.sock"),
    });
    const client = await connectClient(daemon.socketPath, "durable-happy", clients);
    const session = await callTool<SessionResult>(client, "session_create", {
      shell: "zsh",
      workspaceRoot: fixture.workspace,
    });
    const mutation = await callTool<StartedResult>(client, "execute", {
      command: "cd subdir && export ITERM_DURABLE=shared",
      generation: session.generation,
      idempotencyKey: "durable-state",
      sessionId: session.id,
    });
    await callTool(client, "execution_wait", { executionId: mutation.execution.id });

    const python = await callTool<StartedResult>(client, "execute", {
      command: "python3 -q",
      generation: session.generation,
      idempotencyKey: "durable-python",
      sessionId: session.id,
    });
    await waitUntilRunning(client, python.execution.id);
    const interactive = await callTool<SessionResult>(client, "session_get", {
      sessionId: session.id,
    });
    await callTool(client, "input", {
      data: 'import os; print(os.getcwd()); print(os.environ["ITERM_DURABLE"]); print(6 * 7)\nexit()\n',
      expectedScreenVersion: interactive.screenVersion,
      generation: session.generation,
      idempotencyKey: "durable-input",
      sessionId: session.id,
      targetExecutionId: python.execution.id,
    });
    const completed = await callTool<ExecutionResult>(client, "execution_wait", {
      executionId: python.execution.id,
    });
    expect(completed.output).toContain("42");
    expect(completed.output).toContain(join(fixture.workspace, "subdir"));
    expect(completed.output).toContain("shared");

    const sleeping = await callTool<StartedResult>(client, "execute", {
      command: "sleep 10",
      generation: session.generation,
      idempotencyKey: "durable-control-target",
      sessionId: session.id,
    });
    await waitUntilRunning(client, sleeping.execution.id);
    await callTool(client, "control", {
      delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
      generation: session.generation,
      idempotencyKey: "durable-control",
      sessionId: session.id,
      targetExecutionId: sleeping.execution.id,
    });
    const interrupted = await callTool<ExecutionResult>(client, "execution_wait", {
      executionId: sleeping.execution.id,
    });
    expect(interrupted.status).toBe("INTERRUPTED");

    const firstPage = await callTool<EventPageResult>(client, "events_query", {
      after: 0,
      generation: session.generation,
      limit: 3,
      sessionId: session.id,
    });
    expect(firstPage.truncated).toBe(true);
    if (firstPage.nextAfter === undefined) throw new Error("Expected a durable Event cursor");
    await client.close();
    clients.splice(clients.indexOf(client), 1);
    const resumedClient = await connectClient(daemon.socketPath, "durable-resumed", clients);
    const events = await callTool<EventPageResult>(resumedClient, "events_query", {
      after: firstPage.nextAfter,
      generation: session.generation,
      limit: 500,
      sessionId: session.id,
    });
    expect(events.events.some((event) => event.type === "interaction.input_delivered")).toBe(true);
    const attributedOutput = events.events.find(
      (event) => event.type === "terminal.pty_output" && event.executionId === python.execution.id,
    );
    expect(attributedOutput).toMatchObject({
      actor: { id: "agent-durable-happy", type: "agent" },
      executionId: python.execution.id,
    });
    expect(attributedOutput?.actionId).toBeTypeOf("string");

    const durable = await pool.query<{
      action_count: string;
      delivered_count: string;
      event_count: string;
      execution_count: string;
      interrupted_count: string;
      outbox_count: string;
      status: string;
    }>(
      `SELECT s.status,
              (SELECT count(*) FROM actions a WHERE a.session_id = s.id) AS action_count,
              (SELECT count(*) FROM actions a
                WHERE a.session_id = s.id AND a.status = 'DELIVERED') AS delivered_count,
              (SELECT count(*) FROM executions e
                WHERE e.session_id = s.id AND e.status = 'COMPLETED') AS execution_count,
              (SELECT count(*) FROM executions e
                WHERE e.session_id = s.id AND e.status = 'INTERRUPTED') AS interrupted_count,
              (SELECT count(*) FROM session_events v WHERE v.session_id = s.id) AS event_count,
              (SELECT count(*) FROM outbox o WHERE o.aggregate_id = s.id) AS outbox_count
         FROM sessions s WHERE s.id = $1`,
      [session.id],
    );
    expect(durable.rows[0]).toMatchObject({
      action_count: "5",
      delivered_count: "2",
      execution_count: "2",
      interrupted_count: "1",
      outbox_count: "3",
      status: "READY",
    });
    expect(Number.parseInt(durable.rows[0]?.event_count ?? "0", 10)).toBe(
      firstPage.events.length + events.events.length,
    );

    await callTool(resumedClient, "session_close", {
      generation: session.generation,
      sessionId: session.id,
    });
    const closed = await pool.query<{ status: string }>(
      "SELECT status FROM sessions WHERE id = $1",
      [session.id],
    );
    expect(closed.rows[0]?.status).toBe("CLOSED");
  }, 30_000);

  it("marks a SIGKILL-lost generation BROKEN and its Execution UNKNOWN on restart", async () => {
    const fixture = await createFixture();
    const socketPath = join(fixture.root, "crash.sock");
    const ownerId = "owner-m4-durable-crash";
    daemonChild = await startDaemonChild(socketPath, ownerId, databaseUrl ?? "");
    const client = await connectClient(socketPath, "durable-crash", clients);
    const session = await callTool<SessionResult>(client, "session_create", {
      shell: "zsh",
      workspaceRoot: fixture.workspace,
    });
    const sleeping = await callTool<StartedResult>(client, "execute", {
      command: "sleep 30",
      generation: session.generation,
      idempotencyKey: "durable-crash-sleep",
      sessionId: session.id,
    });
    await waitUntilRunning(client, sleeping.execution.id);
    await waitUntilDurableSessionStatus(pool, session.id, "RUNNING");
    const beforeCrash = await pool.query<{ shell_pid: number; status: string }>(
      `SELECT g.shell_pid, s.status
         FROM sessions s JOIN session_generations g
           ON g.session_id = s.id AND g.generation = s.current_generation
        WHERE s.id = $1`,
      [session.id],
    );
    expect(beforeCrash.rows[0]?.status).toBe("RUNNING");

    daemonChild.kill("SIGKILL");
    await waitForExit(daemonChild);
    daemonChild = undefined;
    await client.close().catch(() => undefined);
    clients.splice(clients.indexOf(client), 1);

    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId,
      socketPath,
    });
    expect(daemon.runtime.listSessions()).toEqual([]);
    const recovered = await pool.query<{
      execution_status: string;
      session_status: string;
      unknown_reason: string;
    }>(
      `SELECT s.status AS session_status, e.status AS execution_status, e.unknown_reason
         FROM sessions s JOIN executions e ON e.session_id = s.id
        WHERE s.id = $1 AND e.id = $2`,
      [session.id, sleeping.execution.id],
    );
    expect(recovered.rows[0]).toMatchObject({
      execution_status: "UNKNOWN",
      session_status: "BROKEN",
      unknown_reason: "runtime owner restarted without a graceful close",
    });
    const shellPid = beforeCrash.rows[0]?.shell_pid;
    if (shellPid !== undefined) await waitUntilProcessGone(shellPid);
  }, 30_000);

  async function createFixture(): Promise<{ readonly root: string; readonly workspace: string }> {
    let root = await mkdtemp(join(tmpdir(), "iterminal-m4-durable-"));
    root = await realpath(root);
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "subdir"), { recursive: true });
    return { root, workspace };
  }
});

async function connectClient(socketPath: string, name: string, clients: Client[]): Promise<Client> {
  const transport = new StdioClientTransport({
    args: [join(repositoryRoot, "apps/mcp/src/main.ts")],
    command: join(repositoryRoot, "node_modules/.bin/tsx"),
    cwd: repositoryRoot,
    env: {
      ...getDefaultEnvironment(),
      ITERM_ACTOR_CLIENT: name,
      ITERM_ACTOR_ID: `agent-${name}`,
      ITERM_ACTOR_PRINCIPAL: "durable-test-agent",
      ITERM_RUNTIME_SOCKET: socketPath,
    },
    stderr: "pipe",
  });
  const client = new Client({ name, version: "1.0.0" });
  clients.push(client);
  await client.connect(transport);
  return client;
}

async function startDaemonChild(
  socketPath: string,
  ownerId: string,
  connectionString: string,
): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(repositoryRoot, "apps/runtime-daemon/src/main.ts")],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ITERM_DATABASE_URL: connectionString,
        ITERM_RUNTIME_OWNER_ID: ownerId,
        ITERM_RUNTIME_SOCKET: socketPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  await new Promise<void>((resolveReady, rejectReady) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      rejectReady(new Error(`Timed out starting durable daemon: ${stderr}`));
    }, 10_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes("Runtime daemon listening")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `Durable daemon exited before ready (code=${String(code)}, signal=${signal}): ${stderr}`,
        ),
      );
    });
  });
  return child;
}

async function waitUntilRunning(client: Client, executionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const execution = await callTool<ExecutionResult>(client, "execution_get", { executionId });
    if (execution.status === "RUNNING") return;
    await delay(10);
  }
  throw new Error(`Execution did not enter RUNNING: ${executionId}`);
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

async function waitUntilProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isNodeError(error, "ESRCH")) return;
      throw error;
    }
    await delay(10);
  }
  throw new Error(`Shell process survived daemon SIGKILL: ${pid.toString()}`);
}

async function waitUntilDurableSessionStatus(
  pool: Pool,
  sessionId: string,
  expectedStatus: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ status: string }>(
      "SELECT status FROM sessions WHERE id = $1",
      [sessionId],
    );
    if (result.rows[0]?.status === expectedStatus) return;
    await delay(10);
  }
  throw new Error(`Durable Session did not reach ${expectedStatus}: ${sessionId}`);
}

async function callTool<T>(
  client: Client,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<T> {
  const result = await client.callTool({ arguments: { ...args }, name });
  if (result.isError === true) throw new Error(`MCP tool ${name} failed: ${textContent(result)}`);
  const structured = result.structuredContent;
  if (typeof structured !== "object" || structured === null || !("result" in structured)) {
    throw new Error(`MCP tool ${name} returned no structured result`);
  }
  return structured.result as T;
}

function textContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: "text" }> =>
      Boolean(block.type === "text"),
    )
    .map((block) => block.text)
    .join("\n");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

type SessionResult = {
  readonly generation: number;
  readonly id: string;
  readonly screenVersion: number;
};
type StartedResult = { readonly execution: { readonly id: string } };
type ExecutionResult = { readonly output?: string; readonly status: string };
type EventPageResult = {
  readonly events: readonly {
    readonly actionId?: string;
    readonly actor?: { readonly id: string; readonly type: string };
    readonly executionId?: string;
    readonly type: string;
  }[];
  readonly nextAfter?: number;
  readonly truncated: boolean;
};
