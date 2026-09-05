import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const repositoryRoot = resolve(import.meta.dirname, "../../..");

describeDatabase("B02 durable MCP Execution output cursor", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const fixtureRoots: string[] = [];
  const clients: Client[] = [];
  let daemon: RuntimeDaemonHandle | undefined;

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("B02 output tests refuse to mutate any database except iterminal_test");
    }
    const migrator = new PostgresRuntimeDurability(databaseUrl ?? "");
    await migrator.migrate();
    await migrator.close();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox, artifacts RESTART IDENTITY CASCADE");
    await pool.query(
      `UPDATE artifact_storage_policies
          SET max_bytes = 1073741824, max_artifact_bytes = 16777216,
              retention_milliseconds = 604800000, cleanup_batch_size = 1000,
              updated_at = now()
        WHERE scope = 'default'`,
    );
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    daemon = undefined;
    for (const fixtureRoot of fixtureRoots.splice(0)) {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  afterAll(async () => pool.end());

  it("continues a >ring durable byte stream across MCP restart without releasing the Execution", async () => {
    const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "iterminal-b02-output-")));
    fixtureRoots.push(fixtureRoot);
    const workspaceRoot = join(fixtureRoot, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    daemon = await startRuntimeDaemon({
      buildId: "b02-output-reader",
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-b02-output",
      socketPath: join(fixtureRoot, "runtime.sock"),
    });
    await daemon.waitUntilReady();

    const firstClient = await connectClient(daemon.socketPath, "b02-output-first");
    clients.push(firstClient);
    const capabilities = await callTool<RuntimeCapabilitiesResult>(
      firstClient,
      "runtime_capabilities",
      {},
    );
    expect(capabilities.features).toContain("execution.output.read.v1");
    const session = await callTool<SessionResult>(firstClient, "session_create", {
      idempotencyKey: "b02-output-session",
      shell: "zsh",
      workspaceRoot,
    });
    const started = await callTool<StartedResult>(firstClient, "execute", {
      command:
        'python3 -c \'import os,time; os.write(1,b"X"*2200000); os.write(1,b"RUNNING-MARKER");\nwhile not os.path.exists(".b02-release"): time.sleep(.02)\nos.write(1,b"FINAL-MARKER")\'',
      generation: session.generation,
      idempotencyKey: "b02-large-running-output",
      sessionId: session.id,
    });

    const reconstructed: Buffer[] = [];
    let cursor: string | undefined;
    let runningTail: ExecutionOutputResult | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const page = await callTool<ExecutionOutputResult>(firstClient, "execution_output_read", {
        ...(cursor === undefined ? {} : { cursor }),
        executionId: started.execution.id,
        generation: session.generation,
        maxBytes: 64 * 1024,
        sessionId: session.id,
      });
      expect(page.gap).toBeNull();
      reconstructed.push(...page.chunks.map(decodeChunk));
      cursor = page.nextCursor ?? cursor;
      if (
        Buffer.concat(reconstructed).length > 2 * 1024 * 1024 &&
        page.executionState === "RUNNING" &&
        !page.hasMore
      ) {
        runningTail = page;
        break;
      }
      if (!page.hasMore) await delay(25);
    }
    expect(runningTail).toMatchObject({
      executionState: "RUNNING",
      hasMore: false,
      persistenceLag: "possible",
    });
    expect(Buffer.concat(reconstructed).length).toBeGreaterThan(2 * 1024 * 1024);

    await firstClient.close();
    clients.splice(clients.indexOf(firstClient), 1);
    const secondClient = await connectClient(daemon.socketPath, "b02-output-second");
    clients.push(secondClient);
    const stillRunning = await callTool<ExecutionResult>(secondClient, "execution_get", {
      executionId: started.execution.id,
    });
    expect(stillRunning.status).toBe("RUNNING");
    await writeFile(join(workspaceRoot, ".b02-release"), "release", "utf8");
    const completed = await callTool<ExecutionResult>(secondClient, "execution_wait", {
      executionId: started.execution.id,
    });
    expect(completed.status).toBe("COMPLETED");

    for (;;) {
      const page = await callTool<ExecutionOutputResult>(secondClient, "execution_output_read", {
        ...(cursor === undefined ? {} : { cursor }),
        executionId: started.execution.id,
        generation: session.generation,
        maxBytes: 64 * 1024,
        sessionId: session.id,
      });
      reconstructed.push(...page.chunks.map(decodeChunk));
      cursor = page.nextCursor ?? cursor;
      expect(page.gap).toBeNull();
      expect(page.persistenceLag).toBe("none");
      if (!page.hasMore) break;
    }

    const canonical = await durableExecutionBytes(pool, started.execution.id);
    expect(Buffer.concat(reconstructed)).toEqual(canonical);
    expect(canonical.includes(Buffer.from("RUNNING-MARKER", "utf8"))).toBe(true);
    expect(canonical.includes(Buffer.from("FINAL-MARKER", "utf8"))).toBe(true);
    const ordering = await pool.query<{ output_last: string; terminal_first: string }>(
      `SELECT max(event_sequence) FILTER (WHERE event_type = 'terminal.pty_output')::text AS output_last,
              min(event_sequence) FILTER (WHERE event_type = 'execution.completed')::text AS terminal_first
         FROM session_events WHERE execution_id = $1`,
      [started.execution.id],
    );
    expect(Number(ordering.rows[0]?.output_last)).toBeLessThan(
      Number(ordering.rows[0]?.terminal_first),
    );

    await callTool(secondClient, "session_close", {
      generation: session.generation,
      sessionId: session.id,
    });
  }, 40_000);

  async function connectClient(socketPath: string, name: string): Promise<Client> {
    const transport = new StdioClientTransport({
      args: [join(repositoryRoot, "apps/mcp/src/main.ts")],
      command: join(repositoryRoot, "node_modules/.bin/tsx"),
      cwd: repositoryRoot,
      env: {
        ...getDefaultEnvironment(),
        ITERM_ACTOR_CLIENT: "b02-test-mcp",
        ITERM_ACTOR_ID: "agent-b02-output",
        ITERM_ACTOR_PRINCIPAL: "b02-test-agent",
        ITERM_RPC_TEST_ALLOW_UNAUTHENTICATED: "1",
        ITERM_RUNTIME_SOCKET: socketPath,
        NODE_ENV: "test",
      },
      stderr: "pipe",
    });
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(transport);
    return client;
  }
});

async function durableExecutionBytes(pool: Pool, executionId: string): Promise<Buffer> {
  const result = await pool.query<{
    readonly artifact_content: Buffer | null;
    readonly payload: Readonly<Record<string, unknown>>;
  }>(
    `SELECT event.payload, artifact.content AS artifact_content
       FROM session_events event
       LEFT JOIN artifacts artifact ON artifact.id = event.payload->>'artifactRef'
      WHERE event.execution_id = $1 AND event.event_type = 'terminal.pty_output'
      ORDER BY event.event_sequence ASC`,
    [executionId],
  );
  return Buffer.concat(
    result.rows.map((row) => {
      if (typeof row.payload.data === "string") return Buffer.from(row.payload.data, "utf8");
      if (row.artifact_content !== null) return row.artifact_content;
      throw new Error("Durable output Event content is unavailable");
    }),
  );
}

async function callTool<T>(
  client: Client,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<T> {
  const result = await client.callTool({ arguments: { ...args }, name });
  if (result.isError === true)
    throw new Error(`MCP tool ${name} failed: ${JSON.stringify(result)}`);
  const structured = result.structuredContent;
  if (typeof structured !== "object" || structured === null || !("result" in structured)) {
    throw new Error(`MCP tool ${name} returned no structured result`);
  }
  return structured.result as T;
}

function decodeChunk(chunk: Readonly<{ readonly contentBase64: string }>): Buffer {
  return Buffer.from(chunk.contentBase64, "base64");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

interface RuntimeCapabilitiesResult {
  readonly features: readonly string[];
}

interface SessionResult {
  readonly generation: number;
  readonly id: string;
}

interface StartedResult {
  readonly execution: Readonly<{ readonly id: string }>;
}

interface ExecutionResult {
  readonly status: string;
}

interface ExecutionOutputResult {
  readonly chunks: readonly Readonly<{
    readonly byteLength: number;
    readonly contentBase64: string;
  }>[];
  readonly executionState: string;
  readonly gap: null | Readonly<Record<string, unknown>>;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly persistenceLag: "none" | "possible";
}
