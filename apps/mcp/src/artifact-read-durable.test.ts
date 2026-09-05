import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { RuntimeService, type ShellExecutorFactory } from "@iterminal/application";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const repositoryRoot = resolve(import.meta.dirname, "../../..");

describeDatabase("B01 durable MCP Artifact reads", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const fixtureRoots: string[] = [];
  const clients: Client[] = [];
  let daemon: RuntimeDaemonHandle | undefined;

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("B01 Artifact tests refuse to mutate any database except iterminal_test");
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

  it("reassembles real Unicode PTY output through official MCP without corrupting split text", async () => {
    const fixtureRoot = await realpath(
      await mkdtemp(join(tmpdir(), "iterminal-b01-mcp-artifact-")),
    );
    fixtureRoots.push(fixtureRoot);
    const workspaceRoot = join(fixtureRoot, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    daemon = await startRuntimeDaemon({
      buildId: "b01-artifact-reader",
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-b01-mcp-artifact",
      socketPath: join(fixtureRoot, "runtime.sock"),
    });
    await daemon.waitUntilReady();
    const client = await connectClient(daemon.socketPath, "b01-artifact-reader");
    clients.push(client);

    const capabilities = await callTool<RuntimeCapabilitiesResult>(
      client,
      "runtime_capabilities",
      {},
    );
    expect(capabilities.features).toContain("artifact.read.v1");

    const session = await callTool<SessionResult>(client, "session_create", {
      idempotencyKey: "b01-artifact-session",
      shell: "zsh",
      workspaceRoot,
    });
    const expected = "中文🙂".repeat(2_000);
    const started = await callTool<StartedResult>(client, "execute", {
      command:
        "python3 -c 'import os; os.write(1, (\"\\u4e2d\\u6587\\U0001f642\" * 2000).encode())'",
      generation: session.generation,
      idempotencyKey: "b01-artifact-unicode",
      sessionId: session.id,
    });
    const completed = await callTool<ExecutionResult>(client, "execution_wait", {
      executionId: started.execution.id,
    });
    expect(completed.output).toContain(expected);

    const events = await readAllEvents(client, session);
    const outputEvents = events.filter(
      (event) => event.type === "terminal.pty_output" && event.executionId === started.execution.id,
    );
    expect(outputEvents.length).toBeGreaterThan(0);
    const artifactIds = outputEvents.flatMap((event) =>
      typeof event.payload.artifactRef === "string" ? [event.payload.artifactRef] : [],
    );
    expect(artifactIds.length).toBeGreaterThan(0);

    let unalignedTarget: Readonly<{ artifactId: string; offsetBytes: number }> | undefined;
    for (const artifactId of artifactIds) {
      const whole = await callTool<ArtifactReadFound>(client, "artifact_read", {
        artifactId,
        generation: session.generation,
        maxBytes: 64 * 1024,
        offsetBytes: 0,
        sessionId: session.id,
      });
      const bytes = Buffer.from(whole.contentBase64, "base64");
      const offsetBytes = bytes.findIndex((byte) => byte >= 0x80);
      if (offsetBytes >= 0) {
        unalignedTarget = { artifactId, offsetBytes };
        break;
      }
    }
    if (unalignedTarget === undefined) throw new Error("Expected a Unicode Artifact byte");
    const firstByte = await callTool<ArtifactReadFound>(client, "artifact_read", {
      artifactId: unalignedTarget.artifactId,
      generation: session.generation,
      maxBytes: 1,
      offsetBytes: unalignedTarget.offsetBytes,
      sessionId: session.id,
    });
    expect(firstByte).toMatchObject({ kind: "found", textStatus: "unaligned_utf8" });
    expect(firstByte).not.toHaveProperty("text");

    const reconstructed: Buffer[] = [];
    for (const event of outputEvents) {
      if (typeof event.payload.data === "string") {
        reconstructed.push(Buffer.from(event.payload.data, "utf8"));
        continue;
      }
      if (typeof event.payload.artifactRef !== "string") continue;
      let offsetBytes = 0;
      for (;;) {
        const page = await callTool<ArtifactReadFound>(client, "artifact_read", {
          artifactId: event.payload.artifactRef,
          generation: session.generation,
          maxBytes: 127,
          offsetBytes,
          sessionId: session.id,
        });
        expect(page.kind).toBe("found");
        reconstructed.push(Buffer.from(page.contentBase64, "base64"));
        offsetBytes = page.nextOffset;
        if (page.eof) break;
      }
    }
    expect(Buffer.concat(reconstructed)).toEqual(Buffer.from(completed.output, "utf8"));

    const closedDurability = new PostgresRuntimeDurability(databaseUrl ?? "");
    await closedDurability.close();
    const unavailableRuntime = new RuntimeService(
      new MemoryRuntimeStore(),
      {
        create: () => Promise.reject(new Error("Artifact read does not create an Executor")),
      } satisfies ShellExecutorFactory,
      { durability: closedDurability },
    );
    await expect(
      unavailableRuntime.readArtifact({
        artifactId: artifactIds[0] ?? "art_missing",
        generation: session.generation,
        offsetBytes: 0,
        sessionId: session.id,
      }),
    ).resolves.toMatchObject({
      kind: "unavailable",
      reason: "durability_unavailable",
      retryable: true,
    });

    await callTool(client, "session_close", {
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
        ITERM_ACTOR_CLIENT: "b01-test-mcp",
        ITERM_ACTOR_ID: "agent-b01-artifact",
        ITERM_ACTOR_PRINCIPAL: "b01-test-agent",
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

async function readAllEvents(
  client: Client,
  session: SessionResult,
): Promise<readonly EventResult[]> {
  const events: EventResult[] = [];
  let after = 0;
  for (;;) {
    const page = await callTool<EventPageResult>(client, "events_query", {
      after,
      generation: session.generation,
      limit: 500,
      sessionId: session.id,
    });
    events.push(...page.events);
    if (!page.truncated || page.nextAfter === undefined) return events;
    after = page.nextAfter;
  }
}

async function callTool<T>(
  client: Client,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<T> {
  const result = await client.callTool({ arguments: { ...args }, name });
  if (result.isError === true) throw new Error(`MCP tool ${name} failed`);
  const structured = result.structuredContent;
  if (typeof structured !== "object" || structured === null || !("result" in structured)) {
    throw new Error(`MCP tool ${name} returned no structured result`);
  }
  return structured.result as T;
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
  readonly output: string;
}

interface EventPageResult {
  readonly events: readonly EventResult[];
  readonly nextAfter?: number;
  readonly truncated: boolean;
}

interface EventResult {
  readonly executionId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly type: string;
}

interface ArtifactReadFound {
  readonly contentBase64: string;
  readonly eof: boolean;
  readonly kind: "found";
  readonly nextOffset: number;
  readonly text?: string;
  readonly textStatus: "complete" | "unaligned_utf8";
}
