import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { issueRuntimeRpcGrant } from "@iterminal/rpc-grant";
import {
  DEFAULT_RUNTIME_RPC_AUDIENCE,
  parseRuntimeRpcSecret,
  type RuntimeOperation,
} from "@iterminal/runtime-rpc";

const LOCAL_GRANT_TTL_SECONDS = 24 * 60 * 60;

const MCP_OPERATIONS = [
  "action.lookup",
  "artifact.read",
  "approval.get",
  "approval.list",
  "approval.request",
  "control.send",
  "events.query",
  "execution.get",
  "execution.observe",
  "execution.output.read",
  "execution.start",
  "execution.wait",
  "execution.wait.v2",
  "history.lookup",
  "input.send",
  "interaction.get",
  "runtime.capabilities",
  "screen.cells",
  "screen.frame",
  "console.observe",
  "screen.history",
  "screen.diff",
  "screen.get",
  "screen.region",
  "screen.search",
  "screen.wait",
  "session.checkpoint.get",
  "session.close",
  "session.create",
  "session.fork",
  "session.get",
  "session.list",
  "session.list.v2",
  "terminal.resize",
  "terminal.state.get",
] as const satisfies readonly RuntimeOperation[];

const CONSOLE_OPERATIONS = [
  "action.lookup",
  "approval.decide",
  "approval.pending.list",
  "approval.get",
  "approval.list",
  "control.send",
  "events.query",
  "execution.get",
  "execution.start",
  "execution.wait",
  "input.send",
  "interaction.get",
  "interaction.guard.acquire",
  "interaction.guard.release",
  "interaction.guard.renew",
  "interaction.policy.set",
  "runtime.capabilities",
  "screen.cells",
  "screen.frame",
  "console.observe",
  "screen.history",
  "screen.diff",
  "screen.get",
  "screen.region",
  "screen.search",
  "screen.wait",
  "secret.input.begin",
  "secret.input.finish",
  "secret.input.get",
  "session.checkpoint.get",
  "session.close",
  "session.create",
  "session.fork",
  "session.get",
  "session.list",
  "session.list.v2",
  "terminal.resize",
  "terminal.state.get",
] as const satisfies readonly RuntimeOperation[];

export interface PreparedLocalCredentials {
  readonly consoleGrant: string;
  readonly consoleCredentialPath: string;
  readonly expiresAt: number;
  readonly mcpConfigPath: string;
  readonly rpcAudience: string;
  readonly rpcSecret: Uint8Array;
}

export interface LocalMcpConfiguration {
  readonly mcpServers: Readonly<{
    iterminal: Readonly<{
      args: readonly string[];
      command: string;
      env: Readonly<Record<string, string>>;
    }>;
  }>;
}

export async function prepareLocalCredentials(options: {
  readonly repositoryRoot: string;
  readonly runtimeSocketPath: string;
  readonly stateRoot: string;
  readonly agentName?: string;
  readonly grantTtlSeconds?: number;
}): Promise<PreparedLocalCredentials> {
  const name = options.agentName ?? "local";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(name))
    throw new Error("Agent name must be 1–48 letters, digits, underscores or hyphens");
  const ttl = options.grantTtlSeconds ?? LOCAL_GRANT_TTL_SECONDS;
  const issuedAt = new Date();
  await ensurePrivateDirectory(options.stateRoot);
  const credentialsRoot = join(options.stateRoot, "credentials");
  await ensurePrivateDirectory(credentialsRoot);
  const secretValue = await ensureCanonicalSecret(join(credentialsRoot, "runtime-rpc.secret"), 32);
  const rpcSecret = parseRuntimeRpcSecret(secretValue);
  const consoleGrant = issueRuntimeRpcGrant(
    [
      "--type",
      "human",
      "--client",
      "human-console-web",
      "--scope",
      "paired-prefix",
      "--id-prefix",
      "human_console_",
      "--principal-prefix",
      "local-console:",
      "--operations",
      CONSOLE_OPERATIONS.join(","),
      "--ttl-seconds",
      ttl.toString(),
    ],
    { ITERM_RPC_AUTH_SECRET: secretValue },
    issuedAt,
  ).token;
  const mcpGrant = issueRuntimeRpcGrant(
    [
      "--type",
      "agent",
      "--client",
      "mcp-stdio",
      "--id",
      `agent-${name}`,
      "--principal",
      name === "local" ? "local-agent" : `local-agent:${name}`,
      "--operations",
      MCP_OPERATIONS.join(","),
      "--ttl-seconds",
      ttl.toString(),
    ],
    { ITERM_RPC_AUTH_SECRET: secretValue },
    issuedAt,
  ).token;
  const mcpConfigPath = join(options.stateRoot, name === "local" ? "mcp.json" : `mcp-${name}.json`);
  const mcpCredentialPath = join(credentialsRoot, `mcp-${name}.json`);
  const consoleCredentialPath = join(credentialsRoot, "console.json");
  await writePrivateFile(
    consoleCredentialPath,
    JSON.stringify({ runtimeRpc: { grant: consoleGrant, socketPath: options.runtimeSocketPath } }),
  );
  await writePrivateFile(
    mcpCredentialPath,
    `${JSON.stringify(
      {
        mcpServers: {
          iterminal: {
            args: [join(options.repositoryRoot, "apps/mcp/src/main.ts")],
            command: join(options.repositoryRoot, "node_modules/.bin/tsx"),
            env: {
              ITERM_ACTOR_CLIENT: "mcp-stdio",
              ITERM_ACTOR_ID: `agent-${name}`,
              ITERM_ACTOR_PRINCIPAL: name === "local" ? "local-agent" : `local-agent:${name}`,
              ITERM_RPC_GRANT: mcpGrant,
              ITERM_RUNTIME_SOCKET: options.runtimeSocketPath,
            },
          },
        },
      } satisfies LocalMcpConfiguration,
      null,
      2,
    )}\n`,
  );
  const configuration = JSON.parse(await readFile(mcpCredentialPath, "utf8")) as {
    mcpServers: { iterminal: { env: Record<string, string> } };
  };
  delete configuration.mcpServers.iterminal.env.ITERM_RPC_GRANT;
  configuration.mcpServers.iterminal.env.ITERM_MCP_CONFIG_FILE = mcpCredentialPath;
  await writePrivateFile(mcpConfigPath, `${JSON.stringify(configuration, null, 2)}\n`);
  const prepared = {
    mcpConfigPath,
    rpcAudience: DEFAULT_RUNTIME_RPC_AUDIENCE,
  } as PreparedLocalCredentials;
  Object.defineProperties(prepared, {
    consoleGrant: { enumerable: false, value: consoleGrant },
    consoleCredentialPath: { enumerable: false, value: consoleCredentialPath },
    expiresAt: { enumerable: false, value: (Math.floor(issuedAt.getTime() / 1000) + ttl) * 1000 },
    rpcSecret: { enumerable: false, value: rpcSecret },
  });
  return prepared;
}

export async function ensureLocalPostgresPassword(stateRoot: string): Promise<string> {
  await ensurePrivateDirectory(stateRoot);
  const credentialsRoot = join(stateRoot, "credentials");
  await ensurePrivateDirectory(credentialsRoot);
  return ensureCanonicalSecret(join(credentialsRoot, "postgres.password"), 24);
}

export async function readLocalPostgresPassword(stateRoot: string): Promise<string | undefined> {
  const path = join(stateRoot, "credentials", "postgres.password");
  try {
    return await readCanonicalSecret(path, 24);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export function localPostgresUrl(password: string, port: number): string {
  return `postgresql://iterminal:${encodeURIComponent(password)}@127.0.0.1:${port.toString()}/iterminal`;
}

async function ensureCanonicalSecret(path: string, bytes: number): Promise<string> {
  try {
    return await readCanonicalSecret(path, bytes);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const value = randomBytes(bytes).toString("base64url");
  await writePrivateFile(path, `${value}\n`);
  return value;
}

async function readCanonicalSecret(path: string, bytes: number): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024) {
    throw new Error(`Local credential must be one bounded regular file: ${path}`);
  }
  await chmod(path, 0o600);
  const value = (await readFile(path, "utf8")).trim();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) {
    throw new Error(`Local credential is not canonical base64url: ${path}`);
  }
  return value;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Local state path must be a directory: ${path}`);
  }
  await chmod(path, 0o700);
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
