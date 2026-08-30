import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { startRuntimeRouter, type RuntimeRouterHandle } from "@iterminal/runtime-router";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const repositoryRoot = resolve(import.meta.dirname, "../../..");

describeDatabase("M9.2 official MCP Client through central Router", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const clients: Client[] = [];
  const daemons: RuntimeDaemonHandle[] = [];
  const fixtures: string[] = [];
  const routers: RuntimeRouterHandle[] = [];

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M9 MCP Router tests refuse to mutate any database except iterminal_test");
    }
    const migrator = new PostgresRuntimeDurability(databaseUrl ?? "");
    await migrator.migrate();
    await migrator.close();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox, runtime_workers RESTART IDENTITY CASCADE");
  });

  afterEach(async () => {
    for (const client of clients.splice(0).reverse()) await client.close().catch(() => undefined);
    for (const router of routers.splice(0).reverse()) await router.close().catch(() => undefined);
    for (const daemon of daemons.splice(0).reverse()) await daemon.close().catch(() => undefined);
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  afterAll(async () => pool.end());

  it("places and operates Sessions on two owners without changing MCP tools", async () => {
    const root = await realpath(await mkdtemp(join("/private/tmp", "itr-m92-mcp-")));
    fixtures.push(root);
    const leftWorkspace = join(root, "left");
    const rightWorkspace = join(root, "right");
    await Promise.all([
      mkdir(leftWorkspace, { recursive: true }),
      mkdir(rightWorkspace, { recursive: true }),
    ]);
    daemons.push(
      await startRuntimeDaemon({
        databaseHealthCheckMilliseconds: 50,
        databaseUrl: databaseUrl ?? "",
        ownerId: "owner-m9-mcp-a",
        ownerInstanceId: "instance-m9-mcp-a",
        ownerLeaseMilliseconds: 500,
        socketPath: join(root, "a.sock"),
      }),
      await startRuntimeDaemon({
        databaseHealthCheckMilliseconds: 50,
        databaseUrl: databaseUrl ?? "",
        ownerId: "owner-m9-mcp-b",
        ownerInstanceId: "instance-m9-mcp-b",
        ownerLeaseMilliseconds: 500,
        socketPath: join(root, "b.sock"),
      }),
    );
    const router = await startRuntimeRouter({
      databaseUrl: databaseUrl ?? "",
      socketPath: join(root, "router.sock"),
    });
    routers.push(router);
    const client = await connectClient(router.socketPath);
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "session_create")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "execute")).toBe(true);

    const left = await callTool<SessionResult>(client, "session_create", {
      idempotencyKey: "router-mcp-left-session-create",
      shell: "zsh",
      workspaceRoot: leftWorkspace,
    });
    const right = await callTool<SessionResult>(client, "session_create", {
      idempotencyKey: "router-mcp-right-session-create",
      shell: "zsh",
      workspaceRoot: rightWorkspace,
    });
    expect([left.ownerId, right.ownerId]).toEqual(["owner-m9-mcp-a", "owner-m9-mcp-b"]);

    const leftExecution = await callTool<StartedResult>(client, "execute", {
      command: "export ROUTED_MCP=left && cd .",
      generation: left.generation,
      idempotencyKey: "m9-mcp-left-setup",
      sessionId: left.id,
    });
    await callTool(client, "execution_wait", { executionId: leftExecution.execution.id });
    const observed = await callTool<StartedResult>(client, "execute", {
      command: `printf 'owner=%s cwd=%s\\n' "$ROUTED_MCP" "$PWD"`,
      generation: left.generation,
      idempotencyKey: "m9-mcp-left-observe",
      sessionId: left.id,
    });
    const completed = await callTool<ExecutionResult>(client, "execution_wait", {
      executionId: observed.execution.id,
    });
    expect(completed.output).toContain(`owner=left cwd=${leftWorkspace}`);

    const listed = await callTool<readonly SessionResult[]>(client, "session_list", {});
    expect(listed.map((session) => session.id).sort()).toEqual([left.id, right.id].sort());
    await callTool(client, "session_close", { generation: left.generation, sessionId: left.id });
    await callTool(client, "session_close", { generation: right.generation, sessionId: right.id });
  }, 40_000);

  async function connectClient(socketPath: string): Promise<Client> {
    const transport = new StdioClientTransport({
      args: [join(repositoryRoot, "apps/mcp/src/main.ts")],
      command: join(repositoryRoot, "node_modules/.bin/tsx"),
      cwd: repositoryRoot,
      env: {
        ...getDefaultEnvironment(),
        ITERM_ACTOR_CLIENT: "m9-router-test",
        ITERM_ACTOR_ID: "agent-m9-router",
        ITERM_ACTOR_PRINCIPAL: "m9-router-test",
        ITERM_RUNTIME_SOCKET: socketPath,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "m9-router-client", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);
    return client;
  }
});

async function callTool<T>(
  client: Client,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<T> {
  const result = await client.callTool({ arguments: { ...args }, name });
  if (result.isError === true) {
    throw new Error(`MCP tool ${name} failed: ${textContent(result)}`);
  }
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

interface SessionResult {
  readonly generation: number;
  readonly id: string;
  readonly ownerId: string;
}

interface StartedResult {
  readonly execution: { readonly id: string };
}

interface ExecutionResult {
  readonly output?: string;
  readonly status: string;
}
