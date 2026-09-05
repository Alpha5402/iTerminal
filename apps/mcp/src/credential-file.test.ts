import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import {
  DEFAULT_RUNTIME_RPC_AUDIENCE,
  signRuntimeRpcGrant,
  UnixRuntimeClient,
  type RuntimeOperation,
} from "@iterminal/runtime-rpc";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mcpFileAuthorization } from "./credential-file.js";

const actor = {
  id: "agent-credential-file",
  principal: "local-test",
  client: "mcp-stdio",
  type: "agent" as const,
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
};
let root = "";
let path = "";
let socketPath = "";
let daemon: RuntimeDaemonHandle | undefined;
let client: Client | undefined;
const key = randomBytes(32);

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-mcp-credential-")));
  path = join(root, "mcp.json");
  socketPath = join(root, "runtime.sock");
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  await daemon?.close();
  daemon = undefined;
  await rm(root, { recursive: true, force: true });
});

function grant(
  options: {
    expiresAt?: number;
    secret?: Uint8Array;
    operations?: readonly RuntimeOperation[];
  } = {},
) {
  const now = Math.floor(Date.now() / 1_000);
  return signRuntimeRpcGrant(options.secret ?? key, {
    actor: { ...actor, kind: "exact" },
    audience: DEFAULT_RUNTIME_RPC_AUDIENCE,
    issuedAt: now - 100,
    expiresAt: options.expiresAt ?? now + 3600,
    operations: options.operations ?? ["execution.get", "session.list"],
    grantId: randomUUID(),
    version: 1,
  });
}

async function configuration(token: string, overrides: Record<string, string> = {}) {
  const next = join(root, "next.json");
  await writeFile(
    next,
    JSON.stringify({
      mcpServers: {
        iterminal: {
          env: {
            ITERM_ACTOR_ID: actor.id,
            ITERM_ACTOR_CLIENT: actor.client,
            ITERM_ACTOR_PRINCIPAL: actor.principal,
            ITERM_RUNTIME_SOCKET: socketPath,
            ITERM_RPC_GRANT: token,
            ...overrides,
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  await rename(next, path);
}

describe("explicit MCP credential file", () => {
  it("reads an operator replacement on the next request without a sticky token", async () => {
    const first = grant();
    await configuration(first);
    const source = mcpFileAuthorization(path, socketPath, actor);
    expect(await source()).toBe(first);
    const second = grant();
    await configuration(second);
    expect(await source()).toBe(second);
    expect(
      JSON.stringify(new UnixRuntimeClient(socketPath, { authorizationProvider: source })),
    ).toBe("{}");
  });

  it("rejects expired and mismatched sources without exposing credentials", async () => {
    const expired = grant({ expiresAt: Math.floor(Date.now() / 1000) - 1 });
    await configuration(expired);
    const source = mcpFileAuthorization(path, socketPath, actor);
    await expect(source()).rejects.toMatchObject({
      code: "POLICY_DENIED",
      message: "Configured MCP grant has expired; update the operator-issued local config",
    });
    await configuration(grant(), { ITERM_ACTOR_ID: "another-agent" });
    await expect(source()).rejects.toMatchObject({
      code: "POLICY_DENIED",
      message: "MCP credential file does not match the configured socket and Actor",
    });
    await configuration(grant(), { ITERM_RUNTIME_SOCKET: "/other/runtime.sock" });
    await expect(source()).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await configuration("private-sentinel-invalid-json");
    await expect(source()).rejects.toMatchObject({
      code: "POLICY_DENIED",
      message: "MCP credential file contains an invalid grant",
    });
  });

  it("refuses insecure files, symlinks, oversize and missing sources", async () => {
    const source = mcpFileAuthorization(path, socketPath, actor);
    await expect(source()).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await configuration(grant());
    await chmod(path, 0o644);
    await expect(source()).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await chmod(path, 0o600);
    const link = join(root, "link.json");
    await symlink(path, link);
    await expect(mcpFileAuthorization(link, socketPath, actor)()).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    await writeFile(path, " ".repeat(64 * 1024 + 1));
    await expect(source()).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(() => mcpFileAuthorization("relative.json", socketPath, actor)).toThrow(
      "must be absolute",
    );
  });

  it("does not fall back to another grant source", async () => {
    expect(
      () =>
        new UnixRuntimeClient(socketPath, {
          authorization: grant(),
          authorizationProvider: mcpFileAuthorization(path, socketPath, actor),
        }),
    ).toThrow("Choose one");
    const rpc = new UnixRuntimeClient(socketPath, {
      authorizationProvider: () => Promise.resolve(""),
    });
    await expect(rpc.listSessions()).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it("refreshes an already-running stdio bridge while Runtime still rejects bad signatures and scopes", async () => {
    daemon = await startRuntimeDaemon({
      socketPath,
      rpcAuthentication: { audience: DEFAULT_RUNTIME_RPC_AUDIENCE, secret: key },
    });
    const session = await daemon.runtime.createSession({ shell: "zsh", workspaceRoot: root });
    const execution = await daemon.runtime.execute({
      actor,
      command: "printf 'credential-file-proof\\n'",
      idempotencyKey: "credential-file-proof",
      sessionId: session.id,
      sessionGeneration: session.generation,
    });
    await configuration(grant({ expiresAt: Math.floor(Date.now() / 1000) - 1 }));
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    client = new Client({ name: "credential-file-test", version: "1" });
    const transport = new StdioClientTransport({
      command: join(repositoryRoot, "node_modules/.bin/tsx"),
      args: [join(repositoryRoot, "apps/mcp/src/main.ts")],
      env: {
        ...getDefaultEnvironment(),
        ITERM_MCP_CONFIG_FILE: path,
        ITERM_ACTOR_CLIENT: actor.client,
        ITERM_ACTOR_ID: actor.id,
        ITERM_ACTOR_PRINCIPAL: actor.principal,
        ITERM_RUNTIME_SOCKET: socketPath,
      },
      stderr: "pipe",
    });
    await client.connect(transport);
    const query = () =>
      client!.callTool({ name: "execution_get", arguments: { executionId: execution.id } });
    const expired = await query();
    expect(expired.isError).toBe(true);
    expect(JSON.stringify(expired)).toContain("expired");
    await configuration(grant());
    const valid = await query();
    expect(valid.isError).not.toBe(true);
    expect(valid.structuredContent).toMatchObject({
      result: { id: execution.id, status: "COMPLETED" },
    });
    const forged = grant({ secret: randomBytes(32) });
    await configuration(forged);
    const invalid = await query();
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid)).toContain("Runtime RPC authorization failed");
    expect(JSON.stringify(invalid)).not.toContain(forged);
    await configuration(grant({ operations: ["session.list"] }));
    expect((await query()).isError).toBe(true);
    await configuration(grant());
    expect((await query()).isError).not.toBe(true);
    expect(daemon.runtime.getSession(session.id).status).toBe("READY");
  }, 30000);
});
