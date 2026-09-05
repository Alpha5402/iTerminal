/** Real WS/PTY comparison with the exact pre-remediation Console server. */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type * as Server from "../apps/console/src/server.js";
import { applyScreenDelta, type ScreenDelta } from "../apps/console/src/screen-delta.js";
import type { TerminalConsoleFrame } from "@iterminal/domain";
import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { startRuntimeDaemon } from "../apps/runtime-daemon/src/server.js";
import { UnixRuntimeClient, type RuntimeGateway } from "../packages/runtime-rpc/src/index.js";
import type { WebSocket as Socket } from "../apps/console/node_modules/@types/ws/index.js";
const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "apps/console/package.json"));
const { WebSocket } = require("ws") as { WebSocket: typeof Socket };
const baseline = "5c59a49ed034bb3d6e59231a4c3e93f20128d4ea";
const temporarySource = join(root, "apps/console/src", `benchmark-${randomUUID()}.ts`);
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const results: object[] = [];
process.env.NODE_ENV = "test";
process.env.ITERM_RPC_TEST_ALLOW_UNAUTHENTICATED = "1";
try {
  await writeFile(
    temporarySource,
    execFileSync("git", ["show", `${baseline}:apps/console/src/server.ts`], { cwd: root }),
  );
  for (const mode of ["baseline", "canonical"] as const) {
    const { startHumanConsole } = (await import(
      pathToFileURL(
        mode === "baseline" ? temporarySource : join(root, "apps/console/src/server.ts"),
      ).href
    )) as typeof Server;
    const directory = await realpath(await mkdtemp(join(tmpdir(), "it-ws-benchmark-")));
    const daemon = await startRuntimeDaemon({ socketPath: join(directory, "r.sock") });
    const client = new UnixRuntimeClient(daemon.socketPath);
    const calls: Record<string, number> = {};
    const gateway = new Proxy(client, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls[String(key)] = (calls[String(key)] ?? 0) + 1;
          return Reflect.apply(value, target, args) as unknown;
        };
      },
    }) as RuntimeGateway;
    let server: Server.HumanConsoleServerHandle | undefined;
    let socket: Socket | undefined;
    try {
      const session = await client.createSession({ shell: "zsh", workspaceRoot: directory });
      server = await startHumanConsole({ gateway, port: 0 });
      const response = await fetch(`${server.url}/api/bootstrap`, {
        headers: { "x-iterminal-request": "console" },
      });
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      for (const key of Object.keys(calls)) delete calls[key];
      let messages = 0,
        bytes = 0,
        screens = 0;
      let latestText = "";
      let applied: TerminalConsoleFrame | undefined;
      socket = new WebSocket(
        `${server.url.replace("http", "ws")}/api/sessions/${session.id}/stream?generation=${session.generation}`,
        { headers: { cookie, origin: server.url } },
      );
      socket.on("message", (data) => {
        const text = (
          Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data)
        ).toString();
        const frame = JSON.parse(text) as {
          screen?: TerminalConsoleFrame;
          screenDelta?: ScreenDelta;
          cursor?: number;
        };
        messages++;
        bytes += Buffer.byteLength(text);
        if (frame.screen || frame.screenDelta) screens++;
        if (frame.screen) {
          latestText = frame.screen.lines.join("\n");
          if (mode === "canonical") applied = frame.screen;
        }
        if (frame.screenDelta) {
          if (!applied) throw new Error("Missing benchmark delta baseline");
          applied = applyScreenDelta(applied, frame.screenDelta);
          if (!applied) throw new Error("Invalid benchmark delta");
          latestText = applied.lines.join("\n");
        }
        const screenVersion = frame.screen?.screenVersion ?? frame.screenDelta?.frame.screenVersion;
        if (screenVersion !== undefined)
          socket!.send(JSON.stringify({ type: "ack", screenVersion, cursor: frame.cursor ?? 0 }));
      });
      await sleep(1500);
      const idle = { messages, bytes, screens, calls: { ...calls } };
      const started = await client.startExecute({
        actor: {
          id: "benchmark-agent",
          principal: "benchmark",
          client: "fixture",
          type: "agent",
          capabilities: ACTOR_CAPABILITY_PROFILES.agent,
        },
        sessionId: session.id,
        sessionGeneration: session.generation,
        idempotencyKey: "load",
        command:
          "python3 -c 'import time; [(print(\"stream-line-%03d\" % i, flush=True), time.sleep(.02)) for i in range(50)]'",
      });
      const completion = await client.waitExecution(started.execution.id);
      await sleep(1200);
      const canonical = await client.getConsoleFrame(session.id, session.generation);
      if (
        completion.exitCode !== 0 ||
        !canonical.lines.join("\n").includes("stream-line-049") ||
        !latestText.includes("stream-line-049")
      )
        throw new Error("WS benchmark workload failed");
      results.push({
        mode,
        idleMs: 1500,
        idle,
        total: { messages, bytes, screens, calls },
        completion: completion.status,
        lastOutputPresent: canonical.lines.join("\n").includes("stream-line-049"),
        receivedLastOutputPresent: latestText.includes("stream-line-049"),
      });
    } finally {
      socket?.terminate();
      await server?.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  const report = {
    baseline,
    node: process.version,
    platform: process.platform,
    notes: [
      "Exact baseline Console server with the current Runtime backend in both modes",
      "1500ms idle then 50 lines at 20ms; fast ACK client, not browser paint or slow-client soak",
      "Canonical mode carries styles; baseline sends plain text, so bytes need not decrease",
    ],
    results,
  };
  const output = process.argv.find((value) => value.startsWith("--output="))?.slice(9);
  if (output) {
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(temporarySource, { force: true });
}
