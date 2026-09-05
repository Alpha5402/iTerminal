import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventPage, Session, TerminalConsoleFrame } from "@iterminal/domain";
import { ACTOR_CAPABILITY_PROFILES, RuntimeError } from "@iterminal/domain";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { UnixRuntimeClient, type RuntimeGateway } from "@iterminal/runtime-rpc";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHumanConsole, type HumanConsoleServerHandle } from "./server.js";
import { applyScreenDelta, type ScreenDelta } from "./screen-delta.js";

interface Frame {
  type: string;
  screen?: TerminalConsoleFrame;
  screenDelta?: ScreenDelta;
  screenVersion?: number;
  cursor?: number;
  partial?: boolean;
  atomic?: boolean;
  reason?: string;
  events?: readonly unknown[];
}
const actor = {
  id: "agent-stream",
  principal: "stream-test",
  client: "stream-test",
  type: "agent",
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
} as const;
describe("bounded canonical WebSocket observation", () => {
  let directory: string;
  let daemon: RuntimeDaemonHandle;
  let server: HumanConsoleServerHandle;
  let runtime: UnixRuntimeClient;
  let session: Session;
  let socket: WebSocket;
  const frames: Frame[] = [];
  beforeEach(async () => {
    frames.length = 0;
    directory = await realpath(await mkdtemp(join(tmpdir(), "it-stream-")));
    daemon = await startRuntimeDaemon({ socketPath: join(directory, "r.sock") });
    runtime = new UnixRuntimeClient(daemon.socketPath);
    session = await runtime.createSession({ shell: "zsh", workspaceRoot: directory });
  });
  afterEach(async () => {
    socket?.terminate();
    await server?.close();
    await daemon?.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function connect(overrides: Partial<RuntimeGateway> = {}) {
    const gateway = new Proxy(runtime, {
      get(target, key) {
        const replacement = Reflect.get(overrides, key) as unknown;
        if (replacement !== undefined) return replacement;
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value.bind(target) as unknown) : value;
      },
    });
    server = await startHumanConsole({ gateway, port: 0 });
    const bootstrap = await fetch(`${server.url}/api/bootstrap`, {
      headers: { "x-iterminal-request": "console" },
    });
    const cookie = bootstrap.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    socket = new WebSocket(
      `${server.url.replace("http", "ws")}/api/sessions/${session.id}/stream?generation=${session.generation}`,
      { headers: { cookie, origin: server.url } },
    );
    socket.on("message", (data) =>
      frames.push(
        JSON.parse(
          (Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data)
          ).toString(),
        ) as Frame,
      ),
    );
    await expect.poll(() => frames.length, { timeout: 3000 }).toBeGreaterThan(0);
  }
  async function execute(command: string, key: string) {
    const started = await runtime.startExecute({
      actor,
      sessionId: session.id,
      sessionGeneration: session.generation,
      command,
      idempotencyKey: key,
    });
    await runtime.waitExecution(started.execution.id);
  }
  const ack = (version: number) =>
    socket.send(JSON.stringify({ type: "ack", screenVersion: version, cursor: 0 }));
  it("coalesces unacknowledged screens, ignores stale ACKs, and reconstructs the latest row delta", async () => {
    await connect();
    const initial = frames[0]!.screen!;
    expect(initial.format).toBe("cells-v1");
    await execute("printf 'one\\n'", "one");
    await execute("printf 'two\\n'", "two");
    await expect
      .poll(() => frames.some((frame) => (frame.screenVersion ?? 0) > initial.screenVersion))
      .toBe(true);
    expect(frames.filter((frame) => frame.screen || frame.screenDelta)).toHaveLength(1);
    ack(initial.screenVersion + 10000); // future/forged ACK is not a baseline
    ack(Math.max(0, initial.screenVersion - 1));
    ack(initial.screenVersion);
    await expect
      .poll(() => frames.filter((frame) => frame.screen || frame.screenDelta).length, {
        timeout: 2500,
      })
      .toBe(2);
    const latest = frames.findLast((frame) => frame.screen || frame.screenDelta)!;
    const complete = latest.screen ?? applyScreenDelta(initial, latest.screenDelta!)!;
    expect(complete.lines.join("\n")).toContain("two");
    expect(complete).toEqual(await runtime.getConsoleFrame(session.id, session.generation));
  }, 10_000);
  it("keeps one delayed event read while publishing partial live observations and aborts it on close", async () => {
    let reads = 0;
    let readSignal: AbortSignal | undefined;
    let finish!: (page: EventPage) => void;
    const pending = new Promise<EventPage>((resolve) => {
      finish = resolve;
    });
    try {
      await connect({
        queryEvents: (_id, _generation, _after, _limit, signal) => {
          reads++;
          readSignal = signal;
          return pending;
        },
      });
      expect(frames[0]).toMatchObject({ partial: true, atomic: false });
      ack(frames[0]!.screen!.screenVersion);
      await execute("printf 'live-with-delayed-events\\n'", "partial");
      await expect.poll(() => frames.length).toBeGreaterThan(1);
      expect(reads).toBe(1);
      expect(frames.every((frame) => frame.partial)).toBe(true);
      socket.close();
      await expect.poll(() => readSignal?.aborted).toBe(true);
    } finally {
      finish?.({ events: [], truncated: false });
    }
  });
  it("disconnects a consumer that never renders instead of queueing more frames", async () => {
    await connect();
    await execute("printf 'unacknowledged\\n'", "slow");
    await expect
      .poll(() => frames.some((frame) => frame.reason === "screen_ack_timeout"), { timeout: 7000 })
      .toBe(true);
    expect(frames.filter((frame) => frame.screen || frame.screenDelta)).toHaveLength(1);
    expect(frames.length).toBeLessThan(15); // waiting/heartbeat, not 30 full queries per second
  }, 10_000);
  it("falls back to legacy full screen when capability RPC is unsupported", async () => {
    await connect({
      getRuntimeCapabilities: () =>
        Promise.reject(new RuntimeError("INVALID_REQUEST", "Unsupported Runtime RPC operation")),
    });
    expect(frames[0]!.type).toBe("sync");
    expect(frames[0]!.screen?.lines).toBeDefined();
    expect(frames[0]!.screenDelta).toBeUndefined();
  });
});
