import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { startRuntimeDaemon } from "@iterminal/runtime-daemon";
import { signRuntimeRpcGrant } from "@iterminal/runtime-rpc";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("M10.2 authenticated MCP bridge", () => {
  it("binds the configured bridge Actor to an exact grant on a real zsh path", async () => {
    const root = await realpath(await mkdtemp(join("/private/tmp", "itm10-rpc-mcp-")));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const secret = randomBytes(32);
    const audience = "iterminal-m10-mcp";
    const daemon = await startRuntimeDaemon({
      rpcAuthentication: { audience, secret },
      socketPath: join(root, "runtime.sock"),
    });
    const issuedAt = Math.floor(Date.now() / 1_000);
    const token = signRuntimeRpcGrant(secret, {
      actor: {
        capabilities: ACTOR_CAPABILITY_PROFILES.agent,
        client: "m10-authenticated-mcp",
        id: "agent-m10-authenticated-mcp",
        kind: "exact",
        principal: "m10-authenticated-agent",
        type: "agent",
      },
      audience,
      expiresAt: issuedAt + 60,
      grantId: "m10-authenticated-mcp-grant",
      issuedAt,
      operations: ["execution.start", "execution.wait", "session.close", "session.create"],
      version: 1,
    });
    const transport = new StdioClientTransport({
      args: [join(repositoryRoot, "apps/mcp/src/main.ts")],
      command: join(repositoryRoot, "node_modules/.bin/tsx"),
      cwd: repositoryRoot,
      env: {
        ...getDefaultEnvironment(),
        ITERM_ACTOR_CLIENT: "m10-authenticated-mcp",
        ITERM_ACTOR_ID: "agent-m10-authenticated-mcp",
        ITERM_ACTOR_PRINCIPAL: "m10-authenticated-agent",
        ITERM_RPC_GRANT: token,
        ITERM_RUNTIME_SOCKET: daemon.socketPath,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "m10-authenticated-client", version: "1.0.0" });
    try {
      await client.connect(transport);
      const session = await callTool<SessionResult>(client, "session_create", {
        idempotencyKey: "m10-authenticated-mcp-create",
        shell: "zsh",
        workspaceRoot: workspace,
      });
      const started = await callTool<StartedResult>(client, "execute", {
        command: "printf 'authenticated-mcp\\n'",
        generation: session.generation,
        idempotencyKey: "m10-authenticated-mcp-execute",
        sessionId: session.id,
      });
      const completed = await callTool<ExecutionResult>(client, "execution_wait", {
        executionId: started.execution.id,
      });
      expect(completed.status).toBe("COMPLETED");
      expect(completed.output).toContain("authenticated-mcp");
      await callTool(client, "session_close", {
        generation: session.generation,
        sessionId: session.id,
      });
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);
});

async function callTool<T>(
  client: Client,
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<T> {
  const result = await client.callTool({ arguments: { ...arguments_ }, name });
  if (result.isError === true) throw new Error(`MCP tool ${name} failed`);
  const structured = result.structuredContent;
  if (typeof structured !== "object" || structured === null || !("result" in structured)) {
    throw new Error(`MCP tool ${name} returned no structured result`);
  }
  return structured.result as T;
}

interface SessionResult {
  readonly generation: number;
  readonly id: string;
}

interface StartedResult {
  readonly execution: { readonly id: string };
}

interface ExecutionResult {
  readonly output?: string;
  readonly status: string;
}
