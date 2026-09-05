import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { artifactMcpView } from "./server.js";

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
  daemon = await startRuntimeDaemon({
    buildId: "a05-mcp-l2",
    socketPath: join(fixtureRoot, "runtime.sock"),
  });
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
      "action_lookup",
      "approval_get",
      "approval_list",
      "approval_request",
      "artifact_read",
      "control",
      "events_query",
      "execute",
      "execution_get",
      "execution_observe",
      "execution_output_read",
      "execution_wait",
      "execution_wait_v2",
      "history_lookup",
      "input",
      "interaction_get",
      "runtime_capabilities",
      "screen_cells",
      "screen_diff",
      "screen_get",
      "screen_region",
      "screen_search",
      "screen_wait",
      "session_checkpoint",
      "session_close",
      "session_create",
      "session_fork",
      "session_get",
      "session_list",
      "terminal_resize",
      "terminal_state",
    ]);
    const capabilities = await callTool<RuntimeCapabilitiesResult>(
      first,
      "runtime_capabilities",
      {},
    );
    expect(capabilities).toEqual({
      buildId: "a05-mcp-l2",
      features: [
        "action.execute.v1",
        "action.input.v1",
        "action.lookup.v1",
        "execution.wait.v2",
        "runtime.capabilities.v1",
      ],
      protocolVersion: "1",
    });
    expect(capabilities.features).not.toContain("artifact.read.v1");
    expect(capabilities.features).not.toContain("execution.output.read.v1");
    expect(capabilities.features).not.toContain("execution.observe.v1");
    expect(capabilities.features).not.toContain("history.lookup.v1");
    expect(
      await callTool<HistoryLookupResult>(first, "history_lookup", {
        generation: 1,
        sessionId: "session-no-durable-history",
        target: { idempotencyKey: "missing-history", type: "action" },
      }),
    ).toMatchObject({ kind: "unavailable", reason: "durability_unavailable" });
    expect(
      await callTool<ArtifactReadResult>(first, "artifact_read", {
        artifactId: "art-no-durable-reader",
        generation: 1,
        sessionId: "session-no-durable-reader",
      }),
    ).toMatchObject({ kind: "unavailable", reason: "durability_unavailable" });
    const unavailableOutput = await first.callTool({
      arguments: {
        executionId: "execution-no-durable-reader",
        generation: 1,
        sessionId: "session-no-durable-reader",
      },
      name: "execution_output_read",
    });
    expect(unavailableOutput.isError).toBe(true);
    expect(textContent(unavailableOutput)).toContain('"code":"RUNTIME_UNAVAILABLE"');

    const session = await callTool<SessionResult>(first, "session_create", {
      idempotencyKey: "mcp-stdio-session-create",
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
    expect(
      await callTool<ActionLookupResult>(first, "action_lookup", {
        generation: session.generation,
        idempotencyKey: "m4-shared-state",
        sessionId: session.id,
      }),
    ).toMatchObject({ kind: "not_found", mayStillBeInFlight: true });
    const proposal = await callTool<ApprovalResult>(first, "approval_request", {
      actionIdempotencyKey: "m10-approved-action",
      command: "export ITERM_APPROVED=yes",
      generation: session.generation,
      reason: "Set test environment after Human review",
      requestIdempotencyKey: "m10-approved-request",
      sessionId: session.id,
    });
    expect(proposal).toMatchObject({ status: "PENDING", version: 1 });
    const ownApprovals = await callTool<readonly ApprovalResult[]>(first, "approval_list", {
      generation: session.generation,
      sessionId: session.id,
      status: "PENDING",
    });
    expect(ownApprovals.map((approval) => approval.id)).toContain(proposal.id);
    if (daemon === undefined) throw new Error("Runtime daemon was not started");
    const approvalHuman = new UnixRuntimeClient(daemon.socketPath);
    const decided = await approvalHuman.decideApproval({
      actor: {
        capabilities: ACTOR_CAPABILITY_PROFILES.human,
        client: "m10-human-rpc",
        id: "human-m10",
        principal: "m10-test-human",
        type: "human",
      },
      approvalId: proposal.id,
      decision: "approve",
      expectedVersion: proposal.version,
      idempotencyKey: "m10-human-approve",
      reason: "Exact command reviewed",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    expect(decided.status).toBe("APPROVED");
    const approvedMutation = await callTool<StartedResult>(first, "execute", {
      approvalId: proposal.id,
      command: "export ITERM_APPROVED=yes",
      generation: session.generation,
      idempotencyKey: "m10-approved-action",
      sessionId: session.id,
    });
    await callTool(first, "execution_wait", { executionId: approvedMutation.execution.id });
    expect(
      await callTool<ApprovalResult>(first, "approval_get", {
        approvalId: proposal.id,
        generation: session.generation,
        sessionId: session.id,
      }),
    ).toMatchObject({ status: "CONSUMED", version: 3 });
    const mutation = await callTool<StartedResult>(first, "execute", {
      command: "cd subdir && export ITERM_M4=shared",
      generation: session.generation,
      idempotencyKey: "m4-shared-state",
      sessionId: session.id,
    });
    await callTool(first, "execution_wait", { executionId: mutation.execution.id });
    const lookup = await callTool<ActionLookupResult>(first, "action_lookup", {
      generation: session.generation,
      idempotencyKey: "m4-shared-state",
      sessionId: session.id,
    });
    expect(lookup).toMatchObject({
      actionId: mutation.action.id,
      actionStatus: "COMPLETED",
      executionId: mutation.execution.id,
      executionStatus: "COMPLETED",
      kind: "found",
    });
    expect(lookup).not.toHaveProperty("requestHash");
    expect(lookup).not.toHaveProperty("command");
    expect(lookup).not.toHaveProperty("actor");
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
        capabilities: ACTOR_CAPABILITY_PROFILES.human,
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
    expect(
      await callTool<ActionLookupResult>(second, "action_lookup", {
        generation: session.generation,
        idempotencyKey: "m4-python-agent",
        sessionId: session.id,
      }),
    ).toMatchObject({ actionStatus: "DELIVERED", actionType: "input", kind: "found" });

    const sleeping = await callTool<StartedResult>(second, "execute", {
      command: "sleep 30",
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
    expect(
      await callTool<ActionLookupResult>(second, "action_lookup", {
        generation: session.generation,
        idempotencyKey: "m4-sleep-control",
        sessionId: session.id,
      }),
    ).toMatchObject({ actionStatus: "DELIVERED", actionType: "control", kind: "found" });

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

  it("bounds and cancels a real PTY wait without interrupting the Execution", async () => {
    const client = await connectClient("b03-bounded-wait-client");
    const session = await callTool<SessionResult>(client, "session_create", {
      idempotencyKey: "b03-session-create",
      shell: "zsh",
      workspaceRoot,
    });
    const short = await callTool<StartedResult>(client, "execute", {
      command: "sleep 0.1",
      generation: session.generation,
      idempotencyKey: "b03-default-wait",
      sessionId: session.id,
    });
    await expect(
      callTool<ExecutionWaitV2Result>(client, "execution_wait_v2", {
        executionId: short.execution.id,
      }),
    ).resolves.toEqual({
      completed: true,
      executionId: short.execution.id,
      executionState: "COMPLETED",
    });

    const started = await callTool<StartedResult>(client, "execute", {
      command:
        "i=0; while [ $i -lt 20 ]; do printf 'b03-%02d\\n' $i; i=$((i+1)); sleep 0.05; done; sleep 2",
      generation: session.generation,
      idempotencyKey: "b03-running-output",
      sessionId: session.id,
    });
    await waitUntilRunning(client, started.execution.id);

    await expect(
      callTool<ExecutionWaitV2Result>(client, "execution_wait_v2", {
        executionId: started.execution.id,
        waitMs: 0,
      }),
    ).resolves.toEqual({
      completed: false,
      executionId: started.execution.id,
      executionState: "RUNNING",
    });
    await expect(
      callTool<ExecutionWaitV2Result>(client, "execution_wait_v2", {
        executionId: started.execution.id,
        waitMs: 100,
      }),
    ).resolves.toEqual({
      completed: false,
      executionId: started.execution.id,
      executionState: "RUNNING",
    });

    const controller = new AbortController();
    const cancelled = client.callTool(
      {
        arguments: { executionId: started.execution.id, waitMs: 30_000 },
        name: "execution_wait_v2",
      },
      { signal: controller.signal, timeout: 35_000 },
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    const cancellation = cancelled.catch((error: unknown) => error);
    controller.abort();
    const cancellationError: unknown = await cancellation;
    expect(cancellationError).toBeInstanceOf(Error);
    if (!(cancellationError instanceof Error)) throw new Error("Expected MCP cancellation error");
    expect(cancellationError.message).toContain("AbortError");

    await expect(
      callTool<ExecutionResult>(client, "execution_get", { executionId: started.execution.id }),
    ).resolves.toMatchObject({ status: "RUNNING" });
    await expect(
      callTool<ExecutionWaitV2Result>(client, "execution_wait_v2", {
        executionId: started.execution.id,
        waitMs: 30_000,
      }),
    ).resolves.toEqual({
      completed: true,
      executionId: started.execution.id,
      executionState: "COMPLETED",
    });
    await callTool(client, "session_close", {
      generation: session.generation,
      sessionId: session.id,
    });
  }, 20_000);

  it("marks UTF-8 boundary splits instead of replacing or dropping text", () => {
    const completeBytes = Buffer.from("中文🙂", "utf8");
    const complete = artifactMcpView({
      artifactId: "art-complete",
      contentBase64: completeBytes.toString("base64"),
      contentType: "application/octet-stream",
      eof: true,
      generation: 1,
      kind: "found",
      nextOffset: completeBytes.length,
      offsetBytes: 0,
      returnedBytes: completeBytes.length,
      sessionId: "session-utf8",
      totalBytes: completeBytes.length,
    });
    expect(complete).toMatchObject({ text: "中文🙂", textStatus: "complete" });

    const splitBytes = completeBytes.subarray(0, 2);
    const split = artifactMcpView({
      artifactId: "art-split",
      contentBase64: splitBytes.toString("base64"),
      contentType: "application/octet-stream",
      eof: false,
      generation: 1,
      kind: "found",
      nextOffset: splitBytes.length,
      offsetBytes: 0,
      returnedBytes: splitBytes.length,
      sessionId: "session-utf8",
      totalBytes: completeBytes.length,
    });
    expect(split).toMatchObject({ textStatus: "unaligned_utf8" });
    expect(split).not.toHaveProperty("text");
  });
});

async function connectClient(name: string): Promise<Client> {
  if (daemon === undefined) throw new Error("Runtime daemon was not started");
  const transport = new StdioClientTransport({
    args: [join(repositoryRoot, "apps/mcp/src/main.ts")],
    command: join(repositoryRoot, "node_modules/.bin/tsx"),
    cwd: repositoryRoot,
    env: {
      ...getDefaultEnvironment(),
      ITERM_ACTOR_CLIENT: "m4-test-mcp",
      ITERM_ACTOR_ID: "agent-m4",
      ITERM_ACTOR_PRINCIPAL: "m4-test-agent",
      ITERM_RPC_TEST_ALLOW_UNAUTHENTICATED: "1",
      ITERM_RUNTIME_SOCKET: daemon.socketPath,
      NODE_ENV: "test",
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

type ExecutionWaitV2Result = {
  readonly completed: boolean;
  readonly executionId: string;
  readonly executionState: string;
};

type ActionLookupResult = {
  readonly actionId?: string;
  readonly actionStatus?: string;
  readonly actionType?: string;
  readonly executionId?: string;
  readonly executionStatus?: string;
  readonly kind: string;
  readonly mayStillBeInFlight?: boolean;
};
type HistoryLookupResult = {
  readonly kind: string;
  readonly reason?: string;
};

type ArtifactReadResult = {
  readonly kind: string;
  readonly reason?: string;
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
  readonly geometryVersion: number;
  readonly lines: readonly string[];
  readonly rows: number;
  readonly screenVersion: number;
  readonly sessionGeneration: number;
  readonly sessionId: string;
};

type ApprovalResult = {
  readonly id: string;
  readonly status: string;
  readonly version: number;
};

type RuntimeCapabilitiesResult = {
  readonly buildId: string;
  readonly features: readonly string[];
  readonly protocolVersion: string;
};
