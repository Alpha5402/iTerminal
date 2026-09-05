import { isAbsolute } from "node:path";

import { ACTOR_CAPABILITY_PROFILES, RuntimeError } from "@iterminal/domain";
import {
  parseDeclaredRuntimeRpcGrantClaims,
  readPrivateRuntimeRpcCredentialFile,
  runtimeRpcAuthorizationFromEnvironment,
  type RuntimeRpcEnvironment,
  type UnixRuntimeClient,
} from "@iterminal/runtime-rpc";
import * as z from "zod/v4";

const SOURCE = "console_credential_file";
const configSchema = z.strictObject({
  runtimeRpc: z.strictObject({
    grant: z
      .string()
      .min(1)
      .max(16 * 1_024),
    socketPath: z.string().min(1).max(4_096),
  }),
});

type UnixRuntimeClientOptions = NonNullable<ConstructorParameters<typeof UnixRuntimeClient>[1]>;

export function consoleRuntimeAuthorizationOptions(
  environment: RuntimeRpcEnvironment,
  socketPath: string,
): UnixRuntimeClientOptions {
  const path = environment.ITERM_CONSOLE_CREDENTIAL_FILE;
  if (path !== undefined && environment.ITERM_RPC_GRANT !== undefined) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Configure only ITERM_CONSOLE_CREDENTIAL_FILE or ITERM_RPC_GRANT",
    );
  }
  if (path !== undefined) {
    return { authorizationProvider: consoleFileAuthorization(path, socketPath) };
  }
  const authorization = runtimeRpcAuthorizationFromEnvironment(environment);
  return authorization === undefined ? {} : { authorization };
}

export function consoleFileAuthorization(path: string, socketPath: string): () => Promise<string> {
  if (!isAbsolute(path)) {
    throw new RuntimeError("INVALID_REQUEST", "ITERM_CONSOLE_CREDENTIAL_FILE must be absolute");
  }
  let pinnedScope: string | undefined;
  return async () => {
    let config: z.infer<typeof configSchema>;
    try {
      config = configSchema.parse(await readPrivateRuntimeRpcCredentialFile(path, SOURCE));
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw sourceError("Console credential file contains invalid server configuration");
    }
    if (config.runtimeRpc.socketPath !== socketPath) {
      throw sourceError("Console credential file does not match the configured Runtime socket");
    }
    const claims = declaredClaims(config.runtimeRpc.grant);
    if (!isConsoleActorScope(claims.actor)) {
      throw sourceError("Console credential grant does not match the fixed Human Console Actor");
    }
    if (claims.expiresAt <= Date.now() / 1_000) {
      throw sourceError("Configured Console grant has expired; replace the server credential file");
    }
    const scope = JSON.stringify([claims.audience, claims.operations]);
    if (pinnedScope !== undefined && pinnedScope !== scope) {
      throw sourceError("Console credential replacement changed its authorization scope");
    }
    pinnedScope = scope;
    return config.runtimeRpc.grant;
  };
}

function declaredClaims(token: string) {
  try {
    return parseDeclaredRuntimeRpcGrantClaims(token);
  } catch {
    throw sourceError("Console credential file contains an invalid grant");
  }
}

function isConsoleActorScope(actor: {
  readonly capabilities: readonly string[];
  readonly client: string;
  readonly kind: string;
  readonly type: string;
  readonly idPrefix?: string;
  readonly principalPrefix?: string;
}): boolean {
  return (
    actor.kind === "paired_prefix" &&
    actor.type === "human" &&
    actor.client === "human-console-web" &&
    actor.idPrefix === "human_console_" &&
    actor.principalPrefix === "local-console:" &&
    sameStrings(actor.capabilities, ACTOR_CAPABILITY_PROFILES.human)
  );
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function sourceError(message: string): RuntimeError {
  return new RuntimeError("POLICY_DENIED", message, { source: SOURCE });
}
