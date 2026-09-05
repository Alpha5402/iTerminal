import { isAbsolute } from "node:path";

import { ACTOR_CAPABILITY_PROFILES, RuntimeError, type Actor } from "@iterminal/domain";
import {
  parseDeclaredRuntimeRpcGrantClaims,
  readPrivateRuntimeRpcCredentialFile,
} from "@iterminal/runtime-rpc";
import * as z from "zod/v4";

const SOURCE = "mcp_local_config";
const configSchema = z.object({
  mcpServers: z.object({
    iterminal: z.object({
      env: z.object({
        ITERM_ACTOR_CLIENT: z.string(),
        ITERM_ACTOR_ID: z.string(),
        ITERM_ACTOR_PRINCIPAL: z.string(),
        ITERM_RUNTIME_SOCKET: z.string(),
        ITERM_RPC_GRANT: z
          .string()
          .min(1)
          .max(16 * 1_024),
      }),
    }),
  }),
});

export function mcpFileAuthorization(
  path: string,
  socketPath: string,
  actor: Actor,
): () => Promise<string> {
  if (!isAbsolute(path)) {
    throw new RuntimeError("INVALID_REQUEST", "ITERM_MCP_CONFIG_FILE must be absolute");
  }
  let pinnedScope: string | undefined;
  return async () => {
    let config: z.infer<typeof configSchema>;
    try {
      config = configSchema.parse(await readPrivateRuntimeRpcCredentialFile(path, SOURCE));
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw sourceError("MCP credential file contains invalid local MCP configuration");
    }
    const env = config.mcpServers.iterminal.env;
    if (
      env.ITERM_RUNTIME_SOCKET !== socketPath ||
      env.ITERM_ACTOR_CLIENT !== actor.client ||
      env.ITERM_ACTOR_ID !== actor.id ||
      env.ITERM_ACTOR_PRINCIPAL !== actor.principal
    ) {
      throw sourceError("MCP credential file does not match the configured socket and Actor");
    }
    let claims;
    try {
      claims = parseDeclaredRuntimeRpcGrantClaims(env.ITERM_RPC_GRANT);
    } catch {
      throw sourceError("MCP credential file contains an invalid grant");
    }
    if (
      claims.actor.kind !== "exact" ||
      claims.actor.type !== "agent" ||
      claims.actor.id !== actor.id ||
      claims.actor.client !== actor.client ||
      claims.actor.principal !== actor.principal ||
      JSON.stringify(claims.actor.capabilities) !== JSON.stringify(ACTOR_CAPABILITY_PROFILES.agent)
    ) {
      throw sourceError("MCP credential grant does not match the configured Actor");
    }
    if (claims.expiresAt <= Date.now() / 1_000) {
      throw sourceError(
        "Configured MCP grant has expired; update the operator-issued local config",
      );
    }
    const scope = JSON.stringify([claims.audience, claims.operations]);
    if (pinnedScope !== undefined && pinnedScope !== scope) {
      throw sourceError("MCP credential replacement changed its authorization scope");
    }
    pinnedScope = scope;
    return env.ITERM_RPC_GRANT;
  };
}

function sourceError(message: string): RuntimeError {
  return new RuntimeError("POLICY_DENIED", message, { source: SOURCE });
}
