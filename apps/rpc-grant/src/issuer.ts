import { randomUUID } from "node:crypto";

import {
  ACTOR_CAPABILITY_PROFILES,
  type ActorType,
  type ActorCapability,
  RuntimeError,
} from "@iterminal/domain";
import {
  DEFAULT_RUNTIME_RPC_AUDIENCE,
  RUNTIME_RPC_OPERATIONS,
  parseRuntimeRpcSecret,
  signRuntimeRpcGrant,
  type RuntimeOperation,
  type RuntimeRpcActorGrant,
  type RuntimeRpcEnvironment,
  type RuntimeRpcGrantClaims,
} from "@iterminal/runtime-rpc";

const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_TTL_SECONDS = 60 * 60;
const operationSet = new Set<string>(RUNTIME_RPC_OPERATIONS);

export interface IssuedRuntimeRpcGrant {
  readonly claims: RuntimeRpcGrantClaims;
  readonly token: string;
}

export function issueRuntimeRpcGrant(
  arguments_: readonly string[],
  environment: RuntimeRpcEnvironment,
  now = new Date(),
): IssuedRuntimeRpcGrant {
  const options = parseOptions(arguments_);
  const type = actorType(requiredOption(options, "type"));
  const actor = actorScope(options, type, ACTOR_CAPABILITY_PROFILES[type]);
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const ttlSeconds = positiveIntegerOption(options, "ttl-seconds", DEFAULT_TTL_SECONDS);
  if (ttlSeconds > MAX_TTL_SECONDS) {
    throw invalid(`--ttl-seconds cannot exceed ${MAX_TTL_SECONDS.toString()}`);
  }
  const claims: RuntimeRpcGrantClaims = {
    actor,
    audience: option(options, "audience") ?? DEFAULT_RUNTIME_RPC_AUDIENCE,
    expiresAt: issuedAt + ttlSeconds,
    grantId: option(options, "grant-id") ?? randomUUID(),
    issuedAt,
    operations: operationsOption(options),
    version: 1,
  };
  const secretValue = environment.ITERM_RPC_AUTH_SECRET;
  if (secretValue === undefined || secretValue.length === 0) {
    throw invalid("ITERM_RPC_AUTH_SECRET is required");
  }
  return {
    claims,
    token: signRuntimeRpcGrant(parseRuntimeRpcSecret(secretValue), claims),
  };
}

function actorScope(
  options: ReadonlyMap<string, string>,
  type: ActorType,
  capabilities: readonly ActorCapability[],
): RuntimeRpcActorGrant {
  const scope = option(options, "scope") ?? "exact";
  const client = requiredOption(options, "client");
  if (scope === "exact") {
    rejectOptions(options, ["id-prefix", "principal-prefix"]);
    return {
      capabilities,
      client,
      id: requiredOption(options, "id"),
      kind: "exact",
      principal: requiredOption(options, "principal"),
      type,
    };
  }
  if (scope === "paired-prefix") {
    rejectOptions(options, ["id", "principal"]);
    return {
      capabilities,
      client,
      idPrefix: requiredOption(options, "id-prefix"),
      kind: "paired_prefix",
      principalPrefix: requiredOption(options, "principal-prefix"),
      type,
    };
  }
  throw invalid("--scope must be exact or paired-prefix");
}

function operationsOption(options: ReadonlyMap<string, string>): readonly RuntimeOperation[] {
  const raw = requiredOption(options, "operations");
  const values = raw.split(",");
  if (values.some((value) => value.length === 0)) {
    throw invalid("--operations must be a comma-separated non-empty list");
  }
  if (new Set(values).size !== values.length) {
    throw invalid("--operations cannot contain duplicates");
  }
  for (const value of values) {
    if (!operationSet.has(value)) throw invalid(`Unsupported Runtime RPC operation: ${value}`);
  }
  return values.sort() as RuntimeOperation[];
}

function parseOptions(arguments_: readonly string[]): ReadonlyMap<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === undefined || !flag.startsWith("--") || flag.length === 2 || value === undefined) {
      throw invalid("Grant options must be provided as --name value pairs");
    }
    const name = flag.slice(2);
    if (!KNOWN_OPTIONS.has(name)) throw invalid(`Unknown grant option: --${name}`);
    if (options.has(name)) throw invalid(`Duplicate grant option: --${name}`);
    if (value.length === 0) throw invalid(`--${name} cannot be empty`);
    options.set(name, value);
  }
  return options;
}

const KNOWN_OPTIONS = new Set([
  "audience",
  "client",
  "grant-id",
  "id",
  "id-prefix",
  "operations",
  "principal",
  "principal-prefix",
  "scope",
  "ttl-seconds",
  "type",
]);

function actorType(value: string): ActorType {
  if (value === "human" || value === "agent" || value === "scheduler" || value === "system") {
    return value;
  }
  throw invalid("--type must be human, agent, scheduler, or system");
}

function positiveIntegerOption(
  options: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
): number {
  const raw = option(options, name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || value.toString() !== raw) {
    throw invalid(`--${name} must be a positive integer`);
  }
  return value;
}

function rejectOptions(options: ReadonlyMap<string, string>, names: readonly string[]): void {
  for (const name of names) {
    if (options.has(name)) throw invalid(`--${name} is incompatible with this Actor scope`);
  }
}

function requiredOption(options: ReadonlyMap<string, string>, name: string): string {
  const value = option(options, name);
  if (value === undefined) throw invalid(`--${name} is required`);
  return value;
}

function option(options: ReadonlyMap<string, string>, name: string): string | undefined {
  return options.get(name);
}

function invalid(message: string): RuntimeError {
  return new RuntimeError("INVALID_REQUEST", message);
}
