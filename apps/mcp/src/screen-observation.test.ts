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
  fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m6-observe-")));
  workspaceRoot = join(fixtureRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  daemon = await startRuntimeDaemon({ socketPath: join(fixtureRoot, "runtime.sock") });
  client = await connectClient(daemon.socketPath);
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await daemon?.close().catch(() => undefined);
  if (fixtureRoot !== "") await rm(fixtureRoot, { force: true, recursive: true });
});

describe("M6.2 reactive screen observation", () => {
  it("waits for version/text/stability/exit and searches visible cell columns without polling", async () => {
    const activeClient = required(client, "MCP Client");
    const session = await callTool<SessionResult>(activeClient, "session_create", {
      shell: "zsh",
      workspaceRoot,
    });
    const initial = await callTool<ScreenResult>(activeClient, "screen_get", {
      generation: session.generation,
      sessionId: session.id,
    });
    const started = await callTool<StartedResult>(activeClient, "execute", {
      command:
        `printf '\\033[2J\\033[Hwait-start'; sleep 0.15; ` +
        `printf '\\r\\nNeedle界\\r\\n'; sleep 0.15; printf 'done\\r\\n'`,
      generation: session.generation,
      idempotencyKey: "m6-reactive-observation",
      sessionId: session.id,
    });

    const version = await callTool<WaitResult>(activeClient, "screen_wait", {
      condition: { afterVersion: initial.screenVersion, type: "version" },
      generation: session.generation,
      sessionId: session.id,
      timeoutMilliseconds: 2_000,
    });
    expect(version).toMatchObject({ matched: true, reason: "condition" });
    expect(version.snapshot.screenVersion).toBeGreaterThan(initial.screenVersion);

    const text = await callTool<WaitResult>(activeClient, "screen_wait", {
      condition: { caseSensitive: false, text: "needle界", type: "text" },
      generation: session.generation,
      sessionId: session.id,
      timeoutMilliseconds: 2_000,
    });
    expect(text.matched).toBe(true);
    expect(text.snapshot.lines.join("\n")).toContain("Needle界");

    const search = await callTool<SearchResult>(activeClient, "screen_search", {
      caseSensitive: false,
      generation: session.generation,
      maxMatches: 5,
      query: "NEEDLE界",
      sessionId: session.id,
    });
    expect(search.truncated).toBe(false);
    const visibleMatch = search.matches.find((match) => match.text === "Needle界");
    expect(visibleMatch).toMatchObject({
      endColumn: 8,
      startColumn: 0,
      text: "Needle界",
    });
    expect(visibleMatch?.row).toBeTypeOf("number");

    const stable = await callTool<WaitResult>(activeClient, "screen_wait", {
      condition: { stableMilliseconds: 100, type: "stable" },
      generation: session.generation,
      sessionId: session.id,
      timeoutMilliseconds: 2_000,
    });
    expect(stable).toMatchObject({ matched: true, reason: "condition" });
    expect(stable.waitedMilliseconds).toBeGreaterThanOrEqual(90);

    const exited = await callTool<WaitResult>(activeClient, "screen_wait", {
      condition: { executionId: started.execution.id, type: "execution_exit" },
      generation: session.generation,
      sessionId: session.id,
      timeoutMilliseconds: 2_000,
    });
    expect(exited).toMatchObject({
      execution: { id: started.execution.id, status: "COMPLETED" },
      matched: true,
      reason: "condition",
    });
    expect(exited.snapshot.lines.join("\n")).toContain("done");

    const timedOut = await callTool<WaitResult>(activeClient, "screen_wait", {
      condition: { caseSensitive: true, text: "definitely-not-visible", type: "text" },
      generation: session.generation,
      sessionId: session.id,
      timeoutMilliseconds: 50,
    });
    expect(timedOut).toMatchObject({ matched: false, reason: "timeout" });
    expect(timedOut.waitedMilliseconds).toBeGreaterThanOrEqual(40);

    await callTool(activeClient, "session_close", {
      generation: session.generation,
      sessionId: session.id,
    });
  }, 20_000);
});

async function connectClient(socketPath: string): Promise<Client> {
  const transport = new StdioClientTransport({
    args: [join(repositoryRoot, "apps/mcp/src/main.ts")],
    command: join(repositoryRoot, "node_modules/.bin/tsx"),
    cwd: repositoryRoot,
    env: {
      ...getDefaultEnvironment(),
      ITERM_ACTOR_CLIENT: "m6-observation-client",
      ITERM_ACTOR_ID: "agent-m6-observation",
      ITERM_ACTOR_PRINCIPAL: "m6-test-agent",
      ITERM_RUNTIME_SOCKET: socketPath,
    },
    stderr: "pipe",
  });
  const connected = new Client({ name: "m6-observation-client", version: "1.0.0" });
  await connected.connect(transport);
  return connected;
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

function required<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`Missing ${description}`);
  return value;
}

interface SessionResult {
  readonly generation: number;
  readonly id: string;
}

interface ScreenResult {
  readonly lines: readonly string[];
  readonly screenVersion: number;
}

interface StartedResult {
  readonly execution: { readonly id: string };
}

interface SearchResult {
  readonly matches: readonly {
    readonly endColumn: number;
    readonly row: number;
    readonly startColumn: number;
    readonly text: string;
  }[];
  readonly truncated: boolean;
}

interface WaitResult {
  readonly execution?: { readonly id: string; readonly status: string };
  readonly matched: boolean;
  readonly reason: string;
  readonly snapshot: ScreenResult;
  readonly waitedMilliseconds: number;
}
