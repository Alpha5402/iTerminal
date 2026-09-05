import type { RuntimeGateway } from "@iterminal/runtime-rpc";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import type { Execution, Session } from "@iterminal/domain";
import { expect, it } from "vitest";
import { startRuntimeDaemon } from "../../runtime-daemon/src/server.js";
import {
  prepareLocalCredentials,
  type LocalMcpConfiguration,
} from "../../local-stack/src/credentials.js";

it("shares a real daemon PTY, correlates concurrent requests and preserves it on EOF", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "it-cli-")));
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const socketPath = join(root, "r.sock");
  const credentials = await prepareLocalCredentials({
    repositoryRoot,
    runtimeSocketPath: socketPath,
    stateRoot: root,
  });
  const privateConfig = JSON.parse(
    await readFile(join(root, "credentials/mcp-local.json"), "utf8"),
  ) as LocalMcpConfiguration;
  const daemon = await startRuntimeDaemon({
    socketPath,
    rpcAuthentication: { audience: credentials.rpcAudience, secret: credentials.rpcSecret },
  });
  const child = spawn(process.execPath, ["--import", "tsx", "apps/cli/src/main.ts"], {
    cwd: repositoryRoot,
    env: { ...process.env, ...privateConfig.mcpServers.iterminal.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  type Response = {
    requestId: string;
    ok: boolean;
    result: { execution: Execution } & Session[];
    error?: { code: string };
  };
  const pending = new Map<string, (value: Response) => void>();
  const order: string[] = [];
  lines.on("line", (line) => {
    const response = JSON.parse(line) as Response;
    order.push(response.requestId);
    pending.get(response.requestId)?.(response);
    pending.delete(response.requestId);
  });
  const request = (requestId: string, body: Record<string, unknown>) =>
    new Promise<Response>((resolve) => {
      pending.set(requestId, resolve);
      child.stdin.write(`${JSON.stringify({ requestId, ...body })}\n`);
    });
  try {
    const session = await daemon.runtime.createSession({
      idempotencyKey: "cli-fixture",
      shell: "zsh",
      workspaceRoot: root,
    });
    const list = await request("list", { op: "list" });
    expect(list.ok).toBe(true);
    expect(list.result.some((item) => item.id === session.id)).toBe(true);
    const started = await request("exec", {
      op: "execute",
      sessionId: session.id,
      sessionGeneration: session.generation,
      idempotencyKey: "cli-exec",
      command: "sleep 30",
    });
    expect(started.ok).toBe(true);
    expect(daemon.runtime.getExecution(started.result.execution.id).sessionId).toBe(session.id);
    await expect
      .poll(() => daemon.runtime.getExecution(started.result.execution.id).status)
      .toBe("RUNNING");
    const waiting = request("wait", {
      op: "wait",
      executionId: started.result.execution.id,
      waitMs: 10_000,
    });
    expect((await request("during", { op: "list" })).ok).toBe(true);
    const controlled = await request("control", {
      op: "control",
      sessionId: session.id,
      sessionGeneration: session.generation,
      idempotencyKey: "cli-control",
      targetExecutionId: started.result.execution.id,
      delivery: { mode: "TTY_CONTROL", control: "CTRL_C" },
    });
    expect(controlled).toMatchObject({ ok: true });
    expect((await waiting).ok).toBe(true);
    expect(order.indexOf("during")).toBeLessThan(order.indexOf("wait"));
    const spoof = await request("spoof", {
      op: "execute",
      sessionId: session.id,
      sessionGeneration: session.generation,
      idempotencyKey: "spoof",
      command: "true",
      actor: { id: "agent-other" },
    });
    expect(spoof).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    child.stdin.end();
    expect((await exit)[0]).toBe(0);
    expect(daemon.runtime.getSession(session.id)).toMatchObject({
      generation: session.generation,
      status: "READY",
    });
  } finally {
    child.kill("SIGTERM");
    lines.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it.each(["missing-service", "invalid-grant", "old-protocol"])(
  "reports %s without creating a standalone runtime",
  async (mode) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "it-cli-failure-")));
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const socketPath = join(root, "r.sock");
    const credentials = await prepareLocalCredentials({
      repositoryRoot,
      runtimeSocketPath: socketPath,
      stateRoot: root,
    });
    const config = JSON.parse(
      await readFile(join(root, "credentials/mcp-local.json"), "utf8"),
    ) as LocalMcpConfiguration;
    const { startRuntimeRpcServer } = await import("@iterminal/runtime-rpc");
    let reads = 0;
    const rpc =
      mode === "missing-service"
        ? undefined
        : await startRuntimeRpcServer({
            socketPath,
            authentication: { audience: credentials.rpcAudience, secret: credentials.rpcSecret },
            gateway: {
              getRuntimeCapabilities: () =>
                Promise.resolve({
                  buildId: "cli-fixture",
                  features: ["runtime.capabilities.v1"],
                  protocolVersion: mode === "old-protocol" ? "0" : "1",
                }),
              listSessions: () => {
                reads++;
                return Promise.resolve([]);
              },
            } as unknown as RuntimeGateway,
          });
    const env = { ...process.env, ...config.mcpServers.iterminal.env };
    if (mode === "invalid-grant")
      env.ITERM_RPC_GRANT = `${env.ITERM_RPC_GRANT?.split(".")[0]}.invalid`;
    const child = spawn(process.execPath, ["--import", "tsx", "apps/cli/src/main.ts"], {
      cwd: repositoryRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exit = once(child, "exit");
    try {
      child.stdin.end(`${JSON.stringify({ requestId: "failure", op: "list" })}\n`);
      expect((await exit)[0]).toBe(0);
      const response = JSON.parse(output) as {
        ok: boolean;
        requestId: string;
        error: { code: string; message: string };
      };
      expect(response).toMatchObject({ ok: false, requestId: "failure" });
      expect(response.error.code).toBe(
        mode === "invalid-grant"
          ? "POLICY_DENIED"
          : mode === "old-protocol"
            ? "INVALID_REQUEST"
            : "RUNTIME_UNAVAILABLE",
      );
      expect(output).not.toContain(config.mcpServers.iterminal.env.ITERM_RPC_GRANT);
      expect(reads).toBe(0);
    } finally {
      child.kill("SIGTERM");
      await rpc?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);
