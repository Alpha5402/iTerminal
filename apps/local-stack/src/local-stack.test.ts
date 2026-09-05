import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ensureLocalPostgresPassword,
  prepareLocalCredentials,
  readLocalPostgresPassword,
  type LocalMcpConfiguration,
} from "./credentials.js";
import { startLocalStack, type LocalStackHandle } from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("local stack credential bootstrap", () => {
  const fixtures: string[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  it("writes private reusable secrets and a non-enumerating MCP handoff", async () => {
    const stateRoot = await createFixture(fixtures, "iterminal-local-credentials-");
    const runtimeSocketPath = join(stateRoot, "runtime.sock");
    expect(await readLocalPostgresPassword(stateRoot)).toBeUndefined();

    const firstPassword = await ensureLocalPostgresPassword(stateRoot);
    const credentials = await prepareLocalCredentials({
      repositoryRoot,
      runtimeSocketPath,
      stateRoot,
    });
    const secondPassword = await ensureLocalPostgresPassword(stateRoot);
    const configuration = JSON.parse(
      await readFile(credentials.mcpConfigPath, "utf8"),
    ) as LocalMcpConfiguration;
    const rpcSecret = (
      await readFile(join(stateRoot, "credentials/runtime-rpc.secret"), "utf8")
    ).trim();

    expect(secondPassword).toBe(firstPassword);
    expect(configuration.mcpServers.iterminal).toMatchObject({
      args: [join(repositoryRoot, "apps/mcp/src/main.ts")],
      command: join(repositoryRoot, "node_modules/.bin/tsx"),
      env: {
        ITERM_ACTOR_CLIENT: "mcp-stdio",
        ITERM_ACTOR_ID: "agent-local",
        ITERM_ACTOR_PRINCIPAL: "local-agent",
        ITERM_RUNTIME_SOCKET: runtimeSocketPath,
      },
    });
    const grantToken = configuration.mcpServers.iterminal.env.ITERM_RPC_GRANT;
    expect(grantToken).toBeTypeOf("string");
    if (grantToken === undefined) throw new Error("MCP runtime grant was not written");
    const [encodedGrant] = grantToken.split(".");
    const grantClaims = JSON.parse(
      Buffer.from(encodedGrant ?? "", "base64url").toString("utf8"),
    ) as {
      operations?: unknown;
    };
    expect(grantClaims.operations).toEqual(
      expect.arrayContaining(["artifact.read", "execution.output.read"]),
    );
    expect(await permissions(stateRoot)).toBe(0o700);
    expect(await permissions(join(stateRoot, "credentials"))).toBe(0o700);
    expect(await permissions(credentials.mcpConfigPath)).toBe(0o600);
    expect(await permissions(join(stateRoot, "credentials/postgres.password"))).toBe(0o600);
    expect(await permissions(join(stateRoot, "credentials/runtime-rpc.secret"))).toBe(0o600);
    expect(JSON.stringify(credentials)).toBe(
      JSON.stringify({
        mcpConfigPath: credentials.mcpConfigPath,
        rpcAudience: credentials.rpcAudience,
      }),
    );
    expect(JSON.stringify(credentials)).not.toContain(credentials.consoleGrant);
    expect(await readFile(credentials.mcpConfigPath, "utf8")).not.toContain(rpcSecret);
  });
});

describeDatabase("M10.13 durable local stack", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const clients: Client[] = [];
  const fixtures: string[] = [];
  let stack: LocalStackHandle | undefined;

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M10.13 tests refuse to mutate any database except iterminal_test");
    }
    const migrator = new PostgresRuntimeDurability(databaseUrl ?? "");
    await migrator.migrate();
    await migrator.close();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox RESTART IDENTITY CASCADE");
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
    await stack?.close().catch(() => undefined);
    stack = undefined;
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  afterAll(async () => pool.end());

  it("serves one authenticated MCP and Console path over a durable Runtime", async () => {
    const fixtureRoot = await createFixture(fixtures, "iterminal-local-stack-");
    const stateRoot = join(fixtureRoot, "state");
    const staticRoot = join(fixtureRoot, "console");
    const workspaceRoot = join(fixtureRoot, "workspace");
    await mkdir(staticRoot, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>iTerminal</title>\n");

    stack = await startLocalStack({
      consolePort: 0,
      databaseUrl: databaseUrl ?? "",
      repositoryRoot,
      runtimeSocketPath: join(stateRoot, "runtime.sock"),
      stateRoot,
      staticRoot,
    });
    const configuration = JSON.parse(
      await readFile(stack.mcpConfigPath, "utf8"),
    ) as LocalMcpConfiguration;
    const mcp = configuration.mcpServers.iterminal;
    const client = new Client({ name: "local-stack-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        args: [...mcp.args],
        command: mcp.command,
        cwd: repositoryRoot,
        env: { ...getDefaultEnvironment(), ...mcp.env, NODE_ENV: "test" },
        stderr: "pipe",
      }),
    );

    const session = await callTool<SessionResult>(client, "session_create", {
      idempotencyKey: "local-stack-session",
      shell: "zsh",
      workspaceRoot,
    });
    const missingArtifact = await callTool<ArtifactReadResult>(client, "artifact_read", {
      artifactId: "art_local_stack_missing",
      generation: session.generation,
      sessionId: session.id,
    });
    expect(missingArtifact).toMatchObject({ kind: "not_found" });
    const started = await callTool<StartedResult>(client, "execute", {
      command: "printf 'local-stack-mcp\\n'",
      generation: session.generation,
      idempotencyKey: "local-stack-execute",
      sessionId: session.id,
    });
    const completed = await callTool<ExecutionResult>(client, "execution_wait", {
      executionId: started.execution.id,
    });
    expect(completed).toMatchObject({ status: "COMPLETED" });
    expect(completed.output).toContain("local-stack-mcp");
    const durableOutput = await callTool<ExecutionOutputResult>(client, "execution_output_read", {
      executionId: started.execution.id,
      generation: session.generation,
      sessionId: session.id,
    });
    expect(
      Buffer.concat(
        durableOutput.chunks.map((chunk) => Buffer.from(chunk.contentBase64, "base64")),
      ).toString("utf8"),
    ).toContain("local-stack-mcp");

    const bootstrapResponse = await fetch(`${stack.consoleUrl}/api/bootstrap`, {
      headers: { "x-iterminal-request": "console" },
    });
    expect(bootstrapResponse.status).toBe(200);
    const bootstrap = (await bootstrapResponse.json()) as {
      readonly result?: {
        readonly mcpConnection?: { readonly configJson: string; readonly serverName: string };
        readonly sessions?: readonly SessionResult[];
      };
    };
    const expectedMcpConfig = JSON.stringify(configuration, null, 2);
    expect(bootstrap.result?.mcpConnection).toEqual({
      configJson: expectedMcpConfig,
      serverName: "iterminal",
    });
    expect(JSON.stringify(bootstrap.result?.mcpConnection)).not.toContain(stack.mcpConfigPath);
    expect(bootstrap.result?.sessions).toContainEqual(
      expect.objectContaining({ id: session.id, generation: session.generation }),
    );

    await client.close();
    clients.splice(clients.indexOf(client), 1);
    await stack.close();
    stack = undefined;
    await expect(access(join(stateRoot, "runtime.sock"))).rejects.toMatchObject({ code: "ENOENT" });
    const durable = await pool.query<{ status: string }>(
      "SELECT status FROM sessions WHERE id = $1",
      [session.id],
    );
    expect(durable.rows[0]?.status).toBe("CLOSED");
  }, 30_000);
});

async function createFixture(fixtures: string[], prefix: string): Promise<string> {
  let root = await mkdtemp(join(tmpdir(), prefix));
  root = await realpath(root);
  fixtures.push(root);
  return root;
}

async function permissions(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function callTool<T>(
  client: Client,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<T> {
  const result = await client.callTool({ arguments: { ...args }, name });
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

type SessionResult = {
  readonly generation: number;
  readonly id: string;
  readonly status: string;
};

type StartedResult = {
  readonly execution: { readonly id: string };
};

type ExecutionResult = {
  readonly output?: string;
  readonly status: string;
};

type ArtifactReadResult = {
  readonly kind: "not_found";
};

type ExecutionOutputResult = {
  readonly chunks: readonly { readonly contentBase64: string }[];
};
