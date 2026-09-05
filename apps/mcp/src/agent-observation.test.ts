import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { ACTOR_CAPABILITY_PROFILES, type Actor } from "@iterminal/domain";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import {
  startRuntimeRpcServer,
  UnixRuntimeClient,
  type RuntimeGateway,
  type RuntimeRpcServerHandle,
} from "@iterminal/runtime-rpc";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const human: Actor = {
  capabilities: ACTOR_CAPABILITY_PROFILES.human,
  client: "b04-human-client",
  id: "human-b04-observation",
  principal: "local-b04-human",
  type: "human",
};

describe("B04 compact MCP observation contract", () => {
  const roots: string[] = [];
  const clients: Client[] = [];
  let rpcServer: RuntimeRpcServerHandle | undefined;

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
    await rpcServer?.close().catch(() => undefined);
    rpcServer = undefined;
    for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
  });

  it("preserves UNKNOWN and directs only the original request identity to lookup", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-b04-unknown-")));
    roots.push(root);
    rpcServer = await startRuntimeRpcServer({
      gateway: {
        observeExecution: (
          request: Parameters<NonNullable<RuntimeGateway["observeExecution"]>>[0],
        ) =>
          Promise.resolve({
            gap: null,
            identity: {
              executionId: request.executionId,
              generation: request.generation,
              sessionId: request.sessionId,
            },
            nextActions: ["lookup_original_action"],
            nextCursor: null,
            output: {
              byteLength: 0,
              contentBase64: "",
              encoding: "base64",
              hasMore: false,
              retention: { minimumAvailableSequence: 1, source: "durable" },
              stream: "pty",
              text: "",
              textStatus: "complete",
            },
            state: {
              completed: true,
              executionState: "UNKNOWN",
              persistenceLag: "none",
            },
          }),
      } as unknown as RuntimeGateway,
      socketPath: join(root, "runtime.sock"),
    });
    const client = await connectClient(rpcServer.socketPath, "b04-unknown-client");
    clients.push(client);

    const observed = await callToolEnvelope<ExecutionObservation>(client, "execution_observe", {
      executionId: "execution-unknown",
      generation: 4,
      sessionId: "session-unknown",
      waitMs: 0,
    });
    expect(observed.result.state).toEqual({
      completed: true,
      executionState: "UNKNOWN",
      persistenceLag: "none",
    });
    expect(observed.result.nextActions).toEqual(["lookup_original_action"]);
    expect(JSON.stringify(observed.result)).not.toContain("idempotency");
    expect(JSON.stringify(observed.result)).not.toContain("command");
  });
});

describeDatabase("B04 official MCP compact observation with durable PTY output", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const roots: string[] = [];
  const clients: Client[] = [];
  let daemon: RuntimeDaemonHandle | undefined;

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("B04 observation tests refuse to mutate any database except iterminal_test");
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
    for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
  });

  afterAll(async () => pool.end());

  it("executes, waits, pages exact raw bytes, and keeps readable text honest", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-b04-observe-")));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    daemon = await startRuntimeDaemon({
      buildId: "b04-observation-reader",
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-b04-observation",
      socketPath: join(root, "runtime.sock"),
    });
    await daemon.waitUntilReady();
    const client = await connectClient(daemon.socketPath, "b04-real-client");
    clients.push(client);

    const capabilities = await callTool<RuntimeCapabilities>(client, "runtime_capabilities", {});
    expect(capabilities.features).toContain("execution.observe.v1");
    const session = await callTool<SessionView>(client, "session_create", {
      idempotencyKey: "b04-observation-session",
      shell: "zsh",
      workspaceRoot,
    });

    const ansi = await callTool<StartedView>(client, "execute", {
      command: `printf '\\033[31mANSI-B04\\033[0m\\n'; printf '%s\\n' 'echo SAME-COMMAND-LINE'`,
      generation: session.generation,
      idempotencyKey: "b04-ansi-output",
      sessionId: session.id,
    });
    const ansiObserved = await callToolEnvelope<ExecutionObservation>(client, "execution_observe", {
      executionId: ansi.execution.id,
      generation: session.generation,
      maxBytes: 8 * 1024,
      sessionId: session.id,
      waitMs: 10_000,
    });
    expect(ansiObserved.result.state).toMatchObject({
      completed: true,
      executionState: "COMPLETED",
    });
    expect(ansiObserved.result.output.textStatus).toBe("complete");
    expect(ansiObserved.result.output.text).toContain("␛[31mANSI-B04␛[0m");
    expect(ansiObserved.result.output.text).toContain("echo SAME-COMMAND-LINE");
    expect(ansiObserved.result.output.text).not.toContain("\u001b");
    const ansiBytes = Buffer.from(ansiObserved.result.output.contentBase64, "base64");
    expect(ansiBytes.includes(Buffer.from("\u001b[31mANSI-B04\u001b[0m", "utf8"))).toBe(true);
    expect(ansiBytes).toEqual(await durableExecutionBytes(pool, ansi.execution.id));

    const long = await callTool<StartedView>(client, "execute", {
      command: "python3 -c \"import os; os.write(1, ('分页中文🙂-B04-' * 4000).encode('utf-8'))\"",
      generation: session.generation,
      idempotencyKey: "b04-long-output",
      sessionId: session.id,
    });
    const reconstructed: Buffer[] = [];
    let cursor: string | undefined;
    let sawUnalignedUtf8 = false;
    let pages = 0;
    for (;;) {
      pages += 1;
      if (pages > 200) throw new Error("B04 cursor fixture exceeded its bounded page count");
      const page = await callToolEnvelope<ExecutionObservation>(client, "execution_observe", {
        ...(cursor === undefined ? {} : { cursor }),
        executionId: long.execution.id,
        generation: session.generation,
        maxBytes: 1_025,
        sessionId: session.id,
        waitMs: pages === 1 ? 10_000 : 0,
      });
      expect(page.result.gap).toBeNull();
      reconstructed.push(Buffer.from(page.result.output.contentBase64, "base64"));
      if (page.result.output.textStatus === "unaligned_utf8") sawUnalignedUtf8 = true;
      cursor = page.result.nextCursor ?? cursor;
      if (page.result.output.hasMore) {
        expect(page.result.nextActions).toContain("continue_output");
        continue;
      }
      expect(page.result.state.completed).toBe(true);
      break;
    }
    expect(pages).toBeGreaterThan(1);
    expect(sawUnalignedUtf8).toBe(true);
    expect(Buffer.concat(reconstructed)).toEqual(
      await durableExecutionBytes(pool, long.execution.id),
    );

    const sleeping = await callTool<StartedView>(client, "execute", {
      command:
        'python3 -c \'import os,time; os.write(1,b"WAITING-B04"); time.sleep(1); os.write(1,b"DONE-B04")\'',
      generation: session.generation,
      idempotencyKey: "b04-finite-wait",
      sessionId: session.id,
    });
    const timedOut = await callTool<ExecutionObservation>(client, "execution_observe", {
      executionId: sleeping.execution.id,
      generation: session.generation,
      sessionId: session.id,
      waitMs: 50,
    });
    expect(timedOut.state).toEqual({
      completed: false,
      executionState: "RUNNING",
      persistenceLag: "possible",
    });
    expect(timedOut.nextActions).toContain("wait_for_completion");
    const completed = await callTool<ExecutionObservation>(client, "execution_observe", {
      executionId: sleeping.execution.id,
      generation: session.generation,
      sessionId: session.id,
      waitMs: 10_000,
    });
    expect(completed.state).toMatchObject({ completed: true, executionState: "COMPLETED" });

    await callTool(client, "session_close", {
      generation: session.generation,
      sessionId: session.id,
    });
  }, 45_000);

  it("does not expose output suppressed during a Human sensitive-input period", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-b04-secret-")));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    daemon = await startRuntimeDaemon({
      buildId: "b04-secret-observer",
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-b04-secret",
      socketPath: join(root, "runtime.sock"),
    });
    await daemon.waitUntilReady();
    const client = await connectClient(daemon.socketPath, "b04-secret-client");
    clients.push(client);
    const rpc = new UnixRuntimeClient(daemon.socketPath);
    const session = await rpc.createSession({
      idempotencyKey: "b04-secret-session",
      shell: "zsh",
      workspaceRoot,
    });
    const started = await rpc.startExecute({
      actor: human,
      command:
        'IFS= read -r ITERM_SECRET; printf \'ECHO:%s\\n\' "$ITERM_SECRET"; python3 -c \'import os; os.write(1, b"RAW_" + b"B04_" + b"SENSITIVE_" + b"OUTPUT")\'; sleep 30',
      idempotencyKey: "b04-secret-reader",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await waitUntil(async () => (await rpc.getSession(session.id)).status === "RUNNING");
    const secret = "B04_TRANSIENT_SECRET_7f10";
    const hiddenOutput = "RAW_B04_SENSITIVE_OUTPUT";
    const secretAction = await rpc.beginSecretInput({
      actor: human,
      data: `${secret}\r`,
      idempotencyKey: "b04-secret-submit",
      sessionGeneration: session.generation,
      sessionId: session.id,
      targetExecutionId: started.execution.id,
    });
    await delay(100);

    const observed = await callToolEnvelope<ExecutionObservation>(client, "execution_observe", {
      executionId: started.execution.id,
      generation: session.generation,
      maxBytes: 64 * 1024,
      sessionId: session.id,
      waitMs: 0,
    });
    const raw = Buffer.from(observed.result.output.contentBase64, "base64").toString("utf8");
    expect(raw).toContain("sensitive terminal output redacted");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(hiddenOutput);
    expect(JSON.stringify(observed.result)).not.toContain(secret);
    expect(JSON.stringify(observed.result)).not.toContain(hiddenOutput);

    await rpc.sendControl({
      actor: human,
      bypassGuard: true,
      delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
      idempotencyKey: "b04-secret-stop",
      sessionGeneration: session.generation,
      sessionId: session.id,
      targetExecutionId: started.execution.id,
    });
    await rpc.waitExecutionV2({ executionId: started.execution.id, waitMs: 10_000 });
    const sensitive = await rpc.getSensitiveInput({
      actor: human,
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    if (sensitive === undefined) throw new Error("Sensitive-input fixture state is missing");
    await rpc.finishSensitiveInput({
      actor: human,
      expectedVersion: sensitive.version,
      idempotencyKey: "b04-secret-finish",
      outcome: "completed",
      sensitiveInputId: secretAction.sensitiveInputId,
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await rpc.closeSession(session.id, session.generation);
  }, 30_000);
});

async function connectClient(socketPath: string, name: string): Promise<Client> {
  const transport = new StdioClientTransport({
    args: [join(repositoryRoot, "apps/mcp/src/main.ts")],
    command: join(repositoryRoot, "node_modules/.bin/tsx"),
    cwd: repositoryRoot,
    env: {
      ...getDefaultEnvironment(),
      ITERM_ACTOR_CLIENT: "b04-test-mcp",
      ITERM_ACTOR_ID: "agent-b04-observation",
      ITERM_ACTOR_PRINCIPAL: "b04-test-agent",
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

async function callTool<T>(
  client: Client,
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<T> {
  return (await callToolEnvelope<T>(client, name, arguments_)).result;
}

async function callToolEnvelope<T>(
  client: Client,
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<Readonly<{ result: T }>> {
  const response = await client.callTool({ arguments: { ...arguments_ }, name });
  if (response.isError === true) {
    throw new Error(`MCP tool ${name} failed: ${JSON.stringify(response)}`);
  }
  const structured = response.structuredContent;
  if (typeof structured !== "object" || structured === null || !("result" in structured)) {
    throw new Error(`MCP tool ${name} returned no structured result`);
  }
  const text = response.content.find((content) => content.type === "text");
  if (text?.type !== "text") throw new Error(`MCP tool ${name} returned no text result`);
  expect(JSON.parse(text.text)).toEqual(structured);
  return structured as { result: T };
}

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

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for Runtime state");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

interface RuntimeCapabilities {
  readonly features: readonly string[];
}

interface SessionView {
  readonly generation: number;
  readonly id: string;
}

interface StartedView {
  readonly execution: Readonly<{ readonly id: string }>;
}

interface ExecutionObservation {
  readonly gap: null | Readonly<Record<string, unknown>>;
  readonly identity: Readonly<{
    readonly executionId: string;
    readonly generation: number;
    readonly sessionId: string;
  }>;
  readonly nextActions: readonly string[];
  readonly nextCursor: string | null;
  readonly output: Readonly<{
    readonly byteLength: number;
    readonly contentBase64: string;
    readonly hasMore: boolean;
    readonly text?: string;
    readonly textStatus: "complete" | "unaligned_utf8" | "omitted_for_budget";
  }>;
  readonly state: Readonly<{
    readonly completed: boolean;
    readonly executionState: string;
    readonly persistenceLag: "none" | "possible";
  }>;
}
