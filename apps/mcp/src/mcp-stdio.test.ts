import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const clients: Client[] = [];
let fixtureRoot = "";
let workspaceRoot = "";
let daemon: RuntimeDaemonHandle | undefined;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "iterminal-m4-"));
  fixtureRoot = await realpath(fixtureRoot);
  workspaceRoot = join(fixtureRoot, "workspace");
  await mkdir(join(workspaceRoot, "subdir"), { recursive: true });
  daemon = await startRuntimeDaemon({ socketPath: join(fixtureRoot, "runtime.sock") });
});

afterAll(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  await daemon?.close().catch(() => undefined);
  if (fixtureRoot !== "") await rm(fixtureRoot, { force: true, recursive: true });
});

describe("M4 stdio MCP bridge", () => {
  it("shares one daemon-owned Shell across real MCP Client restarts", async () => {
    const first = await connectClient("m4-client-first");
    const listed = await first.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "control",
      "events_query",
      "execute",
      "execution_get",
      "execution_wait",
      "input",
      "interaction_get",
      "screen_cells",
      "screen_diff",
      "screen_get",
      "screen_region",
      "screen_search",
      "screen_wait",
      "session_close",
      "session_create",
      "session_get",
      "session_list",
    ]);

    const session = await callTool<SessionResult>(first, "session_create", {
      shell: "zsh",
      workspaceRoot,
    });
    const fetched = await callTool<SessionResult>(first, "session_get", {
      sessionId: session.id,
    });
    const sessions = await callTool<readonly SessionResult[]>(first, "session_list", {});
    expect(fetched).toMatchObject({
      generation: session.generation,
      id: session.id,
      status: "READY",
    });
    expect(sessions.some((candidate) => candidate.id === session.id)).toBe(true);
    const mutation = await callTool<StartedResult>(first, "execute", {
      command: "cd subdir && export ITERM_M4=shared",
      generation: session.generation,
      idempotencyKey: "m4-shared-state",
      sessionId: session.id,
    });
    await callTool(first, "execution_wait", { executionId: mutation.execution.id });
    const firstPage = await callTool<EventPageResult>(first, "events_query", {
      after: 0,
      generation: session.generation,
      limit: 3,
      sessionId: session.id,
    });
    expect(firstPage.truncated).toBe(true);
    const cursor = firstPage.nextAfter;
    if (cursor === undefined) throw new Error("Expected a continuation cursor");
    await first.close();
    clients.splice(clients.indexOf(first), 1);

    const second = await connectClient("m4-client-second");
    const recovered = await callTool<EventPageResult>(second, "events_query", {
      after: cursor,
      generation: session.generation,
      limit: 100,
      sessionId: session.id,
    });
    expect(recovered.events.some((event) => event.type === "execution.completed")).toBe(true);
    const observed = await callTool<StartedResult>(second, "execute", {
      command: 'printf "PWD=%s ENV=%s\\n" "$PWD" "$ITERM_M4"',
      generation: session.generation,
      idempotencyKey: "m4-observe-state",
      sessionId: session.id,
    });
    const completed = await callTool<ExecutionResult>(second, "execution_wait", {
      executionId: observed.execution.id,
    });
    expect(completed.output).toContain(`PWD=${join(workspaceRoot, "subdir")}`);
    expect(completed.output).toContain("ENV=shared");
    const screen = await callTool<ScreenResult>(second, "screen_get", {
      generation: session.generation,
      sessionId: session.id,
    });
    expect(screen).toMatchObject({
      buffer: "normal",
      columns: 120,
      rows: 40,
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    expect(screen.lines.join("\n")).toContain("ENV=shared");
    expect(screen.screenVersion).toBeGreaterThan(0);
    const screenSession = await callTool<SessionResult>(second, "session_get", {
      sessionId: session.id,
    });
    expect(screen.screenVersion).toBe(screenSession.screenVersion);
    const staleScreen = await second.callTool({
      arguments: { generation: session.generation + 1, sessionId: session.id },
      name: "screen_get",
    });
    expect(staleScreen.isError).toBe(true);
    expect(textContent(staleScreen)).toContain('"code":"SESSION_GENERATION_CHANGED"');

    const alternate = await callTool<StartedResult>(second, "execute", {
      command: `printf '\\033[?1049h\\033[2J\\033[Halternate-界'; read -r first; printf '\\r\\nhuman=%s\\r\\n' "$first"; read -r second; printf '\\033[?1049l'`,
      generation: session.generation,
      idempotencyKey: "m6-alternate-screen",
      sessionId: session.id,
    });
    await waitUntilRunning(second, alternate.execution.id);
    const alternateScreen = await waitForScreen(
      second,
      session.id,
      session.generation,
      (candidate) =>
        candidate.buffer === "alternate" && candidate.lines.join("\n").includes("alternate-界"),
    );
    if (daemon === undefined) throw new Error("Runtime daemon was not started");
    const human = new UnixRuntimeClient(daemon.socketPath);
    await human.sendInput({
      actor: {
        client: "m6-human-rpc",
        id: "human-m6",
        principal: "m6-test-human",
        type: "human",
      },
      data: "human-change\n",
      expectedScreenVersion: alternateScreen.screenVersion,
      idempotencyKey: "m6-human-change-screen",
      sessionGeneration: session.generation,
      sessionId: session.id,
      targetExecutionId: alternate.execution.id,
    });
    const humanChangedScreen = await waitForScreen(
      second,
      session.id,
      session.generation,
      (candidate) =>
        candidate.screenVersion > alternateScreen.screenVersion &&
        candidate.lines.join("\n").includes("human=human-change"),
    );
    const staleAgentInput = await second.callTool({
      arguments: {
        data: "stale-agent-input\n",
        expectedScreenVersion: alternateScreen.screenVersion,
        generation: session.generation,
        idempotencyKey: "m6-stale-agent-input",
        sessionId: session.id,
        targetExecutionId: alternate.execution.id,
      },
      name: "input",
    });
    expect(staleAgentInput.isError).toBe(true);
    expect(textContent(staleAgentInput)).toContain('"code":"SCREEN_CHANGED"');
    await callTool(second, "input", {
      data: "\n",
      expectedScreenVersion: humanChangedScreen.screenVersion,
      generation: session.generation,
      idempotencyKey: "m6-leave-alternate-screen",
      sessionId: session.id,
      targetExecutionId: alternate.execution.id,
    });
    await callTool(second, "execution_wait", { executionId: alternate.execution.id });
    const restoredScreen = await callTool<ScreenResult>(second, "screen_get", {
      generation: session.generation,
      sessionId: session.id,
    });
    expect(restoredScreen.buffer).toBe("normal");

    const python = await callTool<StartedResult>(second, "execute", {
      command: "python3 -q",
      generation: session.generation,
      idempotencyKey: "m4-python-start",
      sessionId: session.id,
    });
    await waitUntilRunning(second, python.execution.id);
    const busy = await second.callTool({
      arguments: {
        command: "pwd",
        generation: session.generation,
        idempotencyKey: "m4-busy",
        sessionId: session.id,
      },
      name: "execute",
    });
    expect(busy.isError).toBe(true);
    expect(textContent(busy)).toContain('"code":"PTY_BUSY"');

    await callTool(second, "input", {
      data: "shared_value = 41\n",
      generation: session.generation,
      idempotencyKey: "m4-python-human",
      sessionId: session.id,
      targetExecutionId: python.execution.id,
    });
    await callTool(second, "input", {
      data: "print(shared_value + 1)\nexit()\n",
      generation: session.generation,
      idempotencyKey: "m4-python-agent",
      sessionId: session.id,
      targetExecutionId: python.execution.id,
    });
    const pythonCompleted = await callTool<ExecutionResult>(second, "execution_wait", {
      executionId: python.execution.id,
    });
    expect(pythonCompleted.output).toContain("42");

    const sleeping = await callTool<StartedResult>(second, "execute", {
      command: "sleep 10",
      generation: session.generation,
      idempotencyKey: "m4-sleep-start",
      sessionId: session.id,
    });
    await waitUntilRunning(second, sleeping.execution.id);
    await callTool(second, "control", {
      delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
      generation: session.generation,
      idempotencyKey: "m4-sleep-control",
      sessionId: session.id,
      targetExecutionId: sleeping.execution.id,
    });
    const interrupted = await callTool<ExecutionResult>(second, "execution_wait", {
      executionId: sleeping.execution.id,
    });
    expect(interrupted.status).toBe("INTERRUPTED");

    const replay = await callTool<StartedResult>(second, "execute", {
      command: "true",
      generation: session.generation,
      idempotencyKey: "m4-idempotent",
      sessionId: session.id,
    });
    await callTool(second, "execution_wait", { executionId: replay.execution.id });
    const repeated = await callTool<StartedResult>(second, "execute", {
      command: "true",
      generation: session.generation,
      idempotencyKey: "m4-idempotent",
      sessionId: session.id,
    });
    expect(repeated.action.id).toBe(replay.action.id);
    await callTool(second, "session_close", {
      generation: session.generation,
      sessionId: session.id,
    });
  }, 40_000);
});

async function connectClient(name: string): Promise<Client> {
  if (daemon === undefined) throw new Error("Runtime daemon was not started");
  const transport = new StdioClientTransport({
    args: [join(repositoryRoot, "apps/mcp/src/main.ts")],
    command: join(repositoryRoot, "node_modules/.bin/tsx"),
    cwd: repositoryRoot,
    env: {
      ...getDefaultEnvironment(),
      ITERM_ACTOR_CLIENT: name,
      ITERM_ACTOR_ID: "agent-m4",
      ITERM_ACTOR_PRINCIPAL: "m4-test-agent",
      ITERM_RUNTIME_SOCKET: daemon.socketPath,
    },
    stderr: "pipe",
  });
  const client = new Client({ name, version: "1.0.0" });
  clients.push(client);
  await client.connect(transport);
  return client;
}

async function waitUntilRunning(client: Client, executionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const execution = await callTool<ExecutionResult>(client, "execution_get", { executionId });
    if (execution.status === "RUNNING") return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`Execution did not enter RUNNING: ${executionId}`);
}

async function waitForScreen(
  client: Client,
  requestedSessionId: string,
  requestedGeneration: number,
  predicate: (screen: ScreenResult) => boolean,
): Promise<ScreenResult> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const screen = await callTool<ScreenResult>(client, "screen_get", {
      generation: requestedGeneration,
      sessionId: requestedSessionId,
    });
    if (predicate(screen)) return screen;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`Virtual Screen did not reach the expected state: ${requestedSessionId}`);
}

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

type SessionResult = {
  readonly id: string;
  readonly generation: number;
  readonly screenVersion: number;
  readonly status: string;
};

type StartedResult = {
  readonly action: { readonly id: string };
  readonly execution: { readonly id: string };
};

type ExecutionResult = {
  readonly status: string;
  readonly output?: string;
};

type EventPageResult = {
  readonly events: readonly { readonly type: string }[];
  readonly nextAfter?: number;
  readonly truncated: boolean;
};

type ScreenResult = {
  readonly buffer: string;
  readonly columns: number;
  readonly lines: readonly string[];
  readonly rows: number;
  readonly screenVersion: number;
  readonly sessionGeneration: number;
  readonly sessionId: string;
};
