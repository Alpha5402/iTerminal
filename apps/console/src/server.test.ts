import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Actor, InteractionState } from "@iterminal/domain";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";

import { startHumanConsole, type HumanConsoleServerHandle } from "./server.js";

const agent: Actor = {
  client: "m5-console-test-agent",
  id: "agent-m5-console-test",
  principal: "local-m5-console-test",
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  type: "agent",
};

describe("M5 Human Console HTTP/WebSocket adapter", () => {
  const fixtures: string[] = [];
  let daemon: RuntimeDaemonHandle | undefined;
  let consoleServer: HumanConsoleServerHandle | undefined;

  afterEach(async () => {
    await consoleServer?.close().catch(() => undefined);
    consoleServer = undefined;
    await daemon?.close().catch(() => undefined);
    daemon = undefined;
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects non-loopback binding before opening a listener", async () => {
    const fixture = await createFixture(fixtures);
    daemon = await startRuntimeDaemon({ socketPath: join(fixture.root, "runtime.sock") });
    await expect(
      startHumanConsole({
        gateway: new UnixRuntimeClient(daemon.socketPath),
        host: "0.0.0.0",
        port: 0,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("keeps READY/interactive writes on Runtime Actions and releases a Guard on disconnect", async () => {
    const fixture = await createFixture(fixtures);
    daemon = await startRuntimeDaemon({ socketPath: join(fixture.root, "runtime.sock") });
    const runtime = new UnixRuntimeClient(daemon.socketPath);
    consoleServer = await startHumanConsole({ gateway: runtime, port: 0 });
    const bootstrapResponse = await fetch(`${consoleServer.url}/api/bootstrap`);
    expect(bootstrapResponse.status).toBe(200);
    const cookie = required(bootstrapResponse.headers.get("set-cookie")).split(";", 1)[0] ?? "";
    const bootstrap = await bodyResult<{
      readonly actor: Actor;
      readonly sessions: readonly unknown[];
    }>(bootstrapResponse);
    expect(bootstrap.actor.type).toBe("human");
    expect(bootstrap.sessions).toEqual([]);

    const rejectedOrigin = await fetch(`${consoleServer.url}/api/sessions`, {
      body: JSON.stringify({ shell: "zsh", workspaceRoot: fixture.workspace }),
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "https://attacker.example",
        "x-iterminal-request": "console",
      },
      method: "POST",
    });
    expect(rejectedOrigin.status).toBe(403);

    const rejectedHeader = await fetch(`${consoleServer.url}/api/sessions`, {
      body: JSON.stringify({ shell: "zsh", workspaceRoot: fixture.workspace }),
      headers: { cookie, "content-type": "application/json", origin: consoleServer.url },
      method: "POST",
    });
    expect(rejectedHeader.status).toBe(403);

    const session = await requestResult<SessionResult>(consoleServer, cookie, "/api/sessions", {
      body: {
        idempotencyKey: "console-runtime-session-create",
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      },
      method: "POST",
    });
    const readyInput = await request(consoleServer, cookie, `/api/sessions/${session.id}/input`, {
      body: {
        data: "READY_BYPASS\n",
        generation: session.generation,
        idempotencyKey: "m5-ready-bypass",
        targetExecutionId: "exe-none",
      },
      method: "POST",
    });
    expect(readyInput.status).toBe(409);
    expect(await bodyErrorCode(readyInput)).toBe("SESSION_NOT_READY");

    const started = await requestResult<StartedResult>(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/execute`,
      {
        body: {
          command: "python3 -q",
          generation: session.generation,
          idempotencyKey: "m5-console-python",
        },
        method: "POST",
      },
    );
    await waitUntilRunning(runtime, started.execution.id);

    await expectRejectedStream(consoleServer, cookie, session);

    const { frame: sync, socket: firstStream } = await connectStream(
      consoleServer,
      cookie,
      session,
    );
    expect(sync).toMatchObject({ type: "sync" });
    expect(sync.screen).toMatchObject({ columns: 120, rows: 40 });
    const { socket: secondStream } = await connectStream(consoleServer, cookie, session);

    const initial = await runtime.getInteractionState(session.id, session.generation);
    const guarded = await requestResult<InteractionState>(
      consoleServer,
      cookie,
      `/api/sessions/${session.id}/interaction/guard`,
      {
        body: {
          expectedVersion: initial.version,
          generation: session.generation,
          reason: "test raw batch",
          ttlMilliseconds: 1_000,
        },
        method: "POST",
      },
    );
    expect(guarded.guard?.actor).toEqual(bootstrap.actor);
    await expect(
      runtime.sendInput({
        actor: agent,
        data: "agent_blocked = True\n",
        idempotencyKey: "m5-agent-blocked",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      }),
    ).rejects.toMatchObject({ code: "INPUT_GUARDED" });

    await requestResult(consoleServer, cookie, `/api/sessions/${session.id}/input`, {
      body: {
        data: "human_value = 40\n",
        generation: session.generation,
        idempotencyKey: "m5-human-input",
        targetExecutionId: started.execution.id,
      },
      method: "POST",
    });
    firstStream.close(1000, "first viewer disconnect");
    await delay(50);
    expect((await runtime.getInteractionState(session.id, session.generation)).guard).toBeDefined();
    secondStream.close(1000, "last viewer disconnect");
    await waitUntilGuardReleased(runtime, session.id, session.generation);

    await runtime.sendInput({
      actor: agent,
      data: "print(human_value + 2)\nexit()\n",
      idempotencyKey: "m5-agent-after-human",
      sessionGeneration: session.generation,
      sessionId: session.id,
      targetExecutionId: started.execution.id,
    });
    const execution = await runtime.waitExecution(started.execution.id);
    expect(execution.output).toContain("42");
    const events = await runtime.queryEvents(session.id, session.generation, 0, 500);
    const humanInput = events.events.find(
      (event) =>
        event.type === "action.accepted" &&
        event.actor?.id === bootstrap.actor.id &&
        event.actionId !== undefined,
    );
    expect(humanInput).toBeDefined();
    expect(JSON.stringify(events.events)).not.toContain("READY_BYPASS");
  }, 30_000);

  it("exposes checkpoint inspection and attributes an explicit fork to the Human Actor", async () => {
    const fixture = await createFixture(fixtures);
    daemon = await startRuntimeDaemon({ socketPath: join(fixture.root, "runtime.sock") });
    const runtime = new UnixRuntimeClient(daemon.socketPath);
    consoleServer = await startHumanConsole({ gateway: runtime, port: 0 });
    const bootstrapResponse = await fetch(`${consoleServer.url}/api/bootstrap`);
    const cookie = required(bootstrapResponse.headers.get("set-cookie")).split(";", 1)[0] ?? "";
    const bootstrap = await bodyResult<{ readonly actor: Actor }>(bootstrapResponse);

    const parent = await requestResult<SessionResult>(consoleServer, cookie, "/api/sessions", {
      body: {
        idempotencyKey: "console-fork-parent-session-create",
        shell: "zsh",
        workspaceRoot: fixture.workspace,
      },
      method: "POST",
    });
    const checkpoint = await requestResult<CheckpointResult>(
      consoleServer,
      cookie,
      `/api/sessions/${parent.id}/checkpoint?generation=${parent.generation.toString()}`,
    );
    expect(checkpoint).toMatchObject({ sourceStatus: "READY", stale: false, version: 1 });

    const fork = await requestResult<ForkResult>(
      consoleServer,
      cookie,
      `/api/sessions/${parent.id}/fork`,
      {
        body: {
          allowStale: false,
          expectedCheckpointVersion: checkpoint.version,
          generation: parent.generation,
          idempotencyKey: "m7-console-human-fork",
        },
        method: "POST",
      },
    );
    expect(fork).toMatchObject({
      checkpoint: { version: 2 },
      replayed: false,
      session: {
        lineage: {
          checkpointVersion: 2,
          parentGeneration: parent.generation,
          parentSessionId: parent.id,
        },
        status: "READY",
      },
    });
    const events = await runtime.queryEvents(parent.id, parent.generation, 0, 500);
    expect(events.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor: bootstrap.actor, type: "session.fork_requested" }),
        expect.objectContaining({ actor: bootstrap.actor, type: "session.forked" }),
      ]),
    );

    await runtime.closeSession(fork.session.id, fork.session.generation);
    await runtime.closeSession(parent.id, parent.generation);
  }, 30_000);
});

async function createFixture(fixtures: string[]): Promise<{
  readonly root: string;
  readonly workspace: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m5-console-")));
  fixtures.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return { root, workspace };
}

async function request(
  server: HumanConsoleServerHandle,
  cookie: string,
  path: string,
  options: { readonly body?: unknown; readonly method?: string } = {},
): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    headers: {
      cookie,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      origin: server.url,
      ...(options.method === undefined || options.method === "GET"
        ? {}
        : { "x-iterminal-request": "console" }),
    },
    method: options.method ?? "GET",
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function requestResult<T>(
  server: HumanConsoleServerHandle,
  cookie: string,
  path: string,
  options: { readonly body?: unknown; readonly method?: string } = {},
): Promise<T> {
  const response = await request(server, cookie, path, options);
  if (!response.ok) throw new Error(`Console request failed: ${await response.text()}`);
  return bodyResult<T>(response);
}

async function bodyResult<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { readonly result?: T };
  if (body.result === undefined) throw new Error("Console response has no result");
  return body.result;
}

async function bodyErrorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { readonly error?: { readonly code?: string } };
  return body.error?.code;
}

function connectStream(
  server: HumanConsoleServerHandle,
  cookie: string,
  session: SessionResult,
): Promise<{ readonly frame: StreamFrame; readonly socket: WebSocket }> {
  const url = new URL(server.url);
  url.protocol = "ws:";
  url.pathname = `/api/sessions/${session.id}/stream`;
  url.searchParams.set("after", "0");
  url.searchParams.set("generation", session.generation.toString());
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url, { headers: { cookie, origin: server.url } });
    const timeout = setTimeout(
      () => rejectSocket(new Error("Timed out waiting for initial stream frame")),
      5_000,
    );
    socket.once("message", (data) => {
      clearTimeout(timeout);
      resolveSocket({ frame: JSON.parse(rawDataText(data)) as StreamFrame, socket });
    });
    socket.once("error", rejectSocket);
  });
}

function expectRejectedStream(
  server: HumanConsoleServerHandle,
  cookie: string,
  session: SessionResult,
): Promise<void> {
  const url = new URL(server.url);
  url.protocol = "ws:";
  url.pathname = `/api/sessions/${session.id}/stream`;
  url.searchParams.set("after", "0");
  url.searchParams.set("generation", session.generation.toString());
  return new Promise((resolveRejected, rejectRejected) => {
    const socket = new WebSocket(url, { headers: { cookie } });
    const timeout = setTimeout(() => {
      socket.terminate();
      rejectRejected(new Error("Timed out waiting for rejected WebSocket upgrade"));
    }, 5_000);
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      expect(response.statusCode).toBe(403);
      response.resume();
      resolveRejected();
    });
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.close();
      rejectRejected(new Error("WebSocket without Origin unexpectedly opened"));
    });
    socket.once("error", () => undefined);
  });
}

async function waitUntilRunning(runtime: UnixRuntimeClient, executionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const execution = await runtime.getExecution(executionId);
    if (execution.status === "RUNNING") return;
    await delay(10);
  }
  throw new Error(`Execution did not enter RUNNING: ${executionId}`);
}

async function waitUntilGuardReleased(
  runtime: UnixRuntimeClient,
  sessionId: string,
  generation: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await runtime.getInteractionState(sessionId, generation);
    if (state.guard === undefined) return;
    await delay(10);
  }
  throw new Error("Console disconnect did not release its Interaction Guard");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function rawDataText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Expected fixture value");
  return value;
}

interface SessionResult {
  readonly generation: number;
  readonly id: string;
}

interface StartedResult {
  readonly execution: { readonly id: string };
}

interface CheckpointResult {
  readonly sourceStatus: string;
  readonly stale: boolean;
  readonly version: number;
}

interface ForkResult {
  readonly checkpoint: CheckpointResult;
  readonly replayed: boolean;
  readonly session: SessionResult & {
    readonly lineage?: {
      readonly checkpointVersion: number;
      readonly parentGeneration: number;
      readonly parentSessionId: string;
    };
    readonly status: string;
  };
}

interface StreamFrame {
  readonly screen?: { readonly columns: number; readonly rows: number };
  readonly type: string;
}
