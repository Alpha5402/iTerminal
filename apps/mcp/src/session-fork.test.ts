import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
let fixtureRoot = "";
let workspaceRoot = "";
let daemon: RuntimeDaemonHandle | undefined;
let client: Client | undefined;

beforeAll(async () => {
  fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m7-mcp-")));
  workspaceRoot = join(fixtureRoot, "workspace");
  await mkdir(join(workspaceRoot, "packages", "api"), { recursive: true });
  daemon = await startRuntimeDaemon({
    checkpointEnvironmentKeys: ["ITERM_M7_SAFE"],
    socketPath: join(fixtureRoot, "runtime.sock"),
  });
  client = await connectClient(daemon.socketPath);
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await daemon?.close().catch(() => undefined);
  if (fixtureRoot !== "") await rm(fixtureRoot, { force: true, recursive: true });
});

describe("M7.1 official MCP checkpoint fork", () => {
  it("rebuilds one READY child with bounded metadata and idempotent lineage", async () => {
    const activeClient = required(client, "MCP Client");
    const parent = await callTool<SessionResult>(activeClient, "session_create", {
      idempotencyKey: "session-fork-safe-parent-create",
      shell: "zsh",
      workspaceRoot,
    });
    const mutation = await start(activeClient, parent, {
      command: "cd packages/api && export ITERM_M7_SAFE=from-parent UNLISTED_SECRET=not-copied",
      key: "m7-mcp-state",
    });
    await waitExecution(activeClient, mutation.execution.id);
    const checkpoint = await callTool<CheckpointResult>(activeClient, "session_checkpoint", {
      generation: parent.generation,
      sessionId: parent.id,
    });
    expect(checkpoint).toMatchObject({
      environmentKeys: ["ITERM_M7_SAFE"],
      stale: false,
      version: 2,
    });
    expect(JSON.stringify(checkpoint)).not.toContain("from-parent");
    expect(JSON.stringify(checkpoint)).not.toContain("not-copied");

    const forkRequest = {
      allowStale: false,
      expectedCheckpointVersion: checkpoint.version,
      generation: parent.generation,
      idempotencyKey: "m7-mcp-ready-fork",
      sessionId: parent.id,
    } as const;
    const fork = await callTool<ForkResult>(activeClient, "session_fork", forkRequest);
    expect(fork).toMatchObject({
      checkpoint: { stale: false, version: 3 },
      replayed: false,
      session: {
        lineage: {
          checkpointVersion: 3,
          parentGeneration: parent.generation,
          parentSessionId: parent.id,
        },
        status: "READY",
      },
    });
    const childExecution = await start(activeClient, fork.session, {
      command:
        'printf \'PWD=%s SAFE=%s SECRET=%s\\n\' "$PWD" "$ITERM_M7_SAFE" "${UNLISTED_SECRET-unset}"',
      key: "m7-mcp-child-state",
    });
    const childCompleted = await waitExecution(activeClient, childExecution.execution.id);
    expect(childCompleted.output).toContain(`PWD=${join(workspaceRoot, "packages", "api")}`);
    expect(childCompleted.output).toContain("SAFE=from-parent SECRET=unset");

    const replay = await callTool<ForkResult>(activeClient, "session_fork", forkRequest);
    expect(replay.replayed).toBe(true);
    expect(replay.session.id).toBe(fork.session.id);
    const parentEvents = await callTool<EventPage>(activeClient, "events_query", {
      after: 0,
      generation: parent.generation,
      limit: 100,
      sessionId: parent.id,
    });
    expect(parentEvents.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["session.fork_requested", "session.forked"]),
    );
    await close(activeClient, fork.session);
    await close(activeClient, parent);
  }, 30_000);

  it("requires explicit stale acknowledgement while a parent stays RUNNING", async () => {
    const activeClient = required(client, "MCP Client");
    const parent = await callTool<SessionResult>(activeClient, "session_create", {
      idempotencyKey: "session-fork-busy-parent-create",
      shell: "bash",
      workspaceRoot,
    });
    const active = await start(activeClient, parent, {
      command: "sleep 30",
      key: "m7-mcp-busy",
    });
    await waitUntilRunning(activeClient, active.execution.id);
    const checkpoint = await callTool<CheckpointResult>(activeClient, "session_checkpoint", {
      generation: parent.generation,
      sessionId: parent.id,
    });
    expect(checkpoint).toMatchObject({ stale: true, version: 1 });

    const denied = await activeClient.callTool({
      arguments: {
        allowStale: false,
        expectedCheckpointVersion: checkpoint.version,
        generation: parent.generation,
        idempotencyKey: "m7-mcp-stale-denied",
        sessionId: parent.id,
      },
      name: "session_fork",
    });
    expect(denied.isError).toBe(true);
    expect(textContent(denied)).toContain('"code":"CHECKPOINT_STALE"');

    const fork = await callTool<ForkResult>(activeClient, "session_fork", {
      allowStale: true,
      expectedCheckpointVersion: checkpoint.version,
      generation: parent.generation,
      idempotencyKey: "m7-mcp-stale-accepted",
      sessionId: parent.id,
    });
    expect(fork.checkpoint).toMatchObject({ stale: true, version: 1 });
    expect(
      (await callTool<SessionResult>(activeClient, "session_get", { sessionId: parent.id })).status,
    ).toBe("RUNNING");
    await callTool(activeClient, "control", {
      delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
      generation: parent.generation,
      idempotencyKey: "m7-mcp-stop-parent",
      sessionId: parent.id,
      targetExecutionId: active.execution.id,
    });
    await waitExecution(activeClient, active.execution.id);
    await close(activeClient, fork.session);
    await close(activeClient, parent);
  }, 30_000);
});

async function connectClient(socketPath: string): Promise<Client> {
  const transport = new StdioClientTransport({
    args: [join(repositoryRoot, "apps/mcp/src/main.ts")],
    command: join(repositoryRoot, "node_modules/.bin/tsx"),
    cwd: repositoryRoot,
    env: {
      ...getDefaultEnvironment(),
      ITERM_ACTOR_CLIENT: "m7-fork-client",
      ITERM_ACTOR_ID: "agent-m7-fork",
      ITERM_ACTOR_PRINCIPAL: "m7-fork-agent",
      ITERM_RUNTIME_SOCKET: socketPath,
    },
    stderr: "pipe",
  });
  const connected = new Client({ name: "m7-fork-client", version: "1.0.0" });
  await connected.connect(transport);
  return connected;
}

async function start(
  activeClient: Client,
  session: SessionResult,
  input: Readonly<{ command: string; key: string }>,
): Promise<StartedResult> {
  return callTool(activeClient, "execute", {
    command: input.command,
    generation: session.generation,
    idempotencyKey: input.key,
    sessionId: session.id,
  });
}

async function waitExecution(activeClient: Client, executionId: string): Promise<ExecutionResult> {
  return callTool(activeClient, "execution_wait", { executionId });
}

async function waitUntilRunning(activeClient: Client, executionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const execution = await callTool<ExecutionResult>(activeClient, "execution_get", {
      executionId,
    });
    if (execution.status === "RUNNING") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Execution did not enter RUNNING: ${executionId}`);
}

async function close(activeClient: Client, session: SessionResult): Promise<void> {
  await callTool(activeClient, "session_close", {
    generation: session.generation,
    sessionId: session.id,
  });
}

async function callTool<T>(
  activeClient: Client,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<T> {
  const result = await activeClient.callTool({ arguments: { ...args }, name });
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

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is unavailable`);
  return value;
}

interface SessionResult {
  readonly generation: number;
  readonly id: string;
  readonly status: string;
}

interface StartedResult {
  readonly execution: { readonly id: string };
}

interface ExecutionResult {
  readonly id: string;
  readonly output?: string;
  readonly status: string;
}

interface CheckpointResult {
  readonly environmentKeys: readonly string[];
  readonly stale: boolean;
  readonly version: number;
}

interface ForkResult {
  readonly checkpoint: CheckpointResult;
  readonly replayed: boolean;
  readonly session: SessionResult;
}

interface EventPage {
  readonly events: readonly { readonly type: string }[];
}
