import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Actor, InteractionState } from "@iterminal/domain";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const human: Actor = {
  client: "m6-human-console",
  id: "human-m6-interaction",
  principal: "local-m6-human",
  type: "human",
};

describeDatabase("M6.5 durable Interaction Guard through Human RPC and Agent MCP", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const fixtures: string[] = [];
  let daemon: RuntimeDaemonHandle | undefined;
  let mcp: Client | undefined;

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M6.5 tests refuse to mutate any database except iterminal_test");
    }
    const migrator = new PostgresRuntimeDurability(databaseUrl ?? "");
    await migrator.migrate();
    await migrator.close();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox RESTART IDENTITY CASCADE");
  });

  afterEach(async () => {
    await mcp?.close().catch(() => undefined);
    mcp = undefined;
    await daemon?.close().catch(() => undefined);
    daemon = undefined;
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  afterAll(async () => pool.end());

  it("blocks Agent input during a Human Guard, expires once, and enforces policy modes", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m6-guard-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-m6-interaction",
      socketPath: join(root, "runtime.sock"),
    });
    const humanRpc = new UnixRuntimeClient(daemon.socketPath);
    mcp = await connectAgent(daemon.socketPath);

    const session = await callTool<SessionResult>(mcp, "session_create", {
      shell: "zsh",
      workspaceRoot: workspace,
    });
    const started = await callTool<StartedResult>(mcp, "execute", {
      command: "python3 -q",
      generation: session.generation,
      idempotencyKey: "m6-guard-python",
      sessionId: session.id,
    });
    await waitUntilRunning(mcp, started.execution.id);

    const initial = await callTool<InteractionState>(mcp, "interaction_get", {
      generation: session.generation,
      sessionId: session.id,
    });
    expect(initial).toMatchObject({ policy: "human_guarded", version: 1 });
    const guarded = await humanRpc.acquireInteractionGuard({
      actor: human,
      expectedVersion: initial.version,
      reason: "Human raw batch",
      sessionGeneration: session.generation,
      sessionId: session.id,
      ttlMilliseconds: 150,
    });
    expect(guarded.guard).toMatchObject({ actor: human, renewals: 0 });

    const blocked = await mcp.callTool({
      arguments: {
        data: "BLOCKED_SECRET\n",
        generation: session.generation,
        idempotencyKey: "m6-agent-blocked",
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      },
      name: "input",
    });
    expect(blocked.isError).toBe(true);
    expect(textContent(blocked)).toContain('"code":"INPUT_GUARDED"');

    await humanRpc.sendInput({
      actor: human,
      data: "shared_value = 41\n",
      idempotencyKey: "m6-human-holder-input",
      sessionGeneration: session.generation,
      sessionId: session.id,
      targetExecutionId: started.execution.id,
    });
    await delay(180);
    const expired = await callTool<InteractionState>(mcp, "interaction_get", {
      generation: session.generation,
      sessionId: session.id,
    });
    expect(expired).toMatchObject({ policy: "human_guarded", version: guarded.version + 1 });
    expect(expired.guard).toBeUndefined();

    const humanOnly = await humanRpc.setInputPolicy({
      actor: human,
      expectedVersion: expired.version,
      mode: "human_only",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    const deniedAgent = await mcp.callTool({
      arguments: {
        data: "print('denied')\n",
        generation: session.generation,
        idempotencyKey: "m6-human-only-agent",
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      },
      name: "input",
    });
    expect(deniedAgent.isError).toBe(true);
    expect(textContent(deniedAgent)).toContain('"code":"POLICY_DENIED"');

    const agentOnly = await humanRpc.setInputPolicy({
      actor: human,
      expectedVersion: humanOnly.version,
      mode: "agent_only",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await expect(
      humanRpc.sendInput({
        actor: human,
        data: "human_denied = True\n",
        idempotencyKey: "m6-agent-only-human",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await callTool(mcp, "input", {
      data: "print(shared_value + 1)\n",
      generation: session.generation,
      idempotencyKey: "m6-agent-only-agent",
      sessionId: session.id,
      targetExecutionId: started.execution.id,
    });

    const common = await humanRpc.setInputPolicy({
      actor: human,
      expectedVersion: agentOnly.version,
      mode: "common",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    expect(common.policy).toBe("common");
    await callTool(mcp, "input", {
      data: "exit()\n",
      generation: session.generation,
      idempotencyKey: "m6-agent-exit",
      sessionId: session.id,
      targetExecutionId: started.execution.id,
    });
    const completed = await callTool<ExecutionResult>(mcp, "execution_wait", {
      executionId: started.execution.id,
    });
    expect(completed.output).toContain("42");

    const durable = await pool.query<{
      guard_id: string | null;
      input_policy: string;
      state_version: string;
    }>(
      `SELECT input_policy, state_version, guard_id
         FROM interaction_guards
        WHERE session_id = $1 AND session_generation = $2`,
      [session.id, session.generation],
    );
    expect(durable.rows[0]).toEqual({
      guard_id: null,
      input_policy: "common",
      state_version: common.version.toString(),
    });
    const rejectedAction = await pool.query<{ count: string }>(
      `SELECT count(*) FROM actions WHERE session_id = $1 AND idempotency_key = $2`,
      [session.id, "m6-agent-blocked"],
    );
    expect(rejectedAction.rows[0]?.count).toBe("0");
    const audit = await pool.query<{ event_type: string; payload: unknown }>(
      `SELECT event_type, payload FROM session_events
        WHERE session_id = $1 AND event_type LIKE 'interaction.%'
        ORDER BY event_sequence`,
      [session.id],
    );
    expect(audit.rows.filter((row) => row.event_type === "interaction.guard_expired")).toHaveLength(
      1,
    );
    expect(JSON.stringify(audit.rows)).not.toContain("BLOCKED_SECRET");

    await callTool(mcp, "session_close", {
      generation: session.generation,
      sessionId: session.id,
    });
  }, 30_000);
});

async function connectAgent(socketPath: string): Promise<Client> {
  const transport = new StdioClientTransport({
    args: [join(repositoryRoot, "apps/mcp/src/main.ts")],
    command: join(repositoryRoot, "node_modules/.bin/tsx"),
    cwd: repositoryRoot,
    env: {
      ...getDefaultEnvironment(),
      ITERM_ACTOR_CLIENT: "m6-interaction-agent",
      ITERM_ACTOR_ID: "agent-m6-interaction",
      ITERM_ACTOR_PRINCIPAL: "m6-interaction-agent",
      ITERM_RUNTIME_SOCKET: socketPath,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "m6-interaction-agent", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function waitUntilRunning(client: Client, executionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const execution = await callTool<ExecutionResult>(client, "execution_get", { executionId });
    if (execution.status === "RUNNING") return;
    await delay(10);
  }
  throw new Error(`Execution did not enter RUNNING: ${executionId}`);
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

interface SessionResult {
  readonly generation: number;
  readonly id: string;
}

interface StartedResult {
  readonly execution: { readonly id: string };
}

interface ExecutionResult {
  readonly output?: string;
  readonly status: string;
}
