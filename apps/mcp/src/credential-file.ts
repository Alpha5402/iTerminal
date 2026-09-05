import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { ACTOR_CAPABILITY_PROFILES, RuntimeError, type Actor } from "@iterminal/domain";
import * as z from "zod/v4";

const MAX_CONFIG_BYTES = 64 * 1_024;
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

const declaredClaimsSchema = z.object({
  actor: z.object({
    kind: z.literal("exact"),
    type: z.literal("agent"),
    client: z.string(),
    id: z.string(),
    principal: z.string(),
    capabilities: z.array(z.string()),
  }),
  expiresAt: z.number().int().positive(),
});

export function mcpFileAuthorization(
  path: string,
  socketPath: string,
  actor: Actor,
): () => Promise<string> {
  if (!isAbsolute(path)) {
    throw new RuntimeError("INVALID_REQUEST", "ITERM_MCP_CONFIG_FILE must be absolute");
  }
  return async () => {
    const config = await readPrivateConfiguration(path);
    const env = config.mcpServers.iterminal.env;
    if (
      env.ITERM_RUNTIME_SOCKET !== socketPath ||
      env.ITERM_ACTOR_CLIENT !== actor.client ||
      env.ITERM_ACTOR_ID !== actor.id ||
      env.ITERM_ACTOR_PRINCIPAL !== actor.principal
    ) {
      throw sourceError("MCP credential file does not match the configured socket and Actor");
    }
    let claims: z.infer<typeof declaredClaimsSchema>;
    try {
      const [encoded, signature, extra] = env.ITERM_RPC_GRANT.split(".");
      if (!encoded || !signature || extra !== undefined) throw new Error();
      claims = declaredClaimsSchema.parse(
        JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
      );
    } catch {
      throw sourceError("MCP credential file contains an invalid grant");
    }
    if (
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
    return env.ITERM_RPC_GRANT;
  };
}

async function readPrivateConfiguration(path: string): Promise<z.infer<typeof configSchema>> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size > MAX_CONFIG_BYTES ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && stat.uid !== process.getuid())
      )
        throw new Error();
      const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      let length = 0;
      for (;;) {
        const read = await file.read(bytes, length, bytes.length - length);
        length += read.bytesRead;
        if (length > MAX_CONFIG_BYTES) throw new Error();
        if (read.bytesRead === 0) break;
      }
      return configSchema.parse(JSON.parse(bytes.subarray(0, length).toString("utf8")));
    } finally {
      await file.close();
    }
  } catch {
    throw sourceError("MCP credential file must be readable, private, and valid local MCP JSON");
  }
}

function sourceError(message: string): RuntimeError {
  return new RuntimeError("POLICY_DENIED", message, { source: "mcp_local_config" });
}
