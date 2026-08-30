import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";

import type { Actor, ActorCapability, ActorType } from "@iterminal/domain";
import { ACTOR_CAPABILITIES, RuntimeError, isCanonicalActorCapabilities } from "@iterminal/domain";
import * as z from "zod/v4";

import type { RuntimeOperation } from "./index.js";

const GRANT_VERSION = 1;
export const DEFAULT_RUNTIME_RPC_AUDIENCE = "iterminal-runtime-rpc";
const MAX_GRANT_BYTES = 16 * 1024;
const MAX_GRANT_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 30;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

const capabilitySchema = z
  .array(z.enum(ACTOR_CAPABILITIES))
  .min(1)
  .max(ACTOR_CAPABILITIES.length)
  .refine(isCanonicalActorCapabilities, "Actor capabilities must be canonical");

const actorGrantBase = z.strictObject({
  capabilities: capabilitySchema,
  client: z.string().min(1).max(256),
  type: z.enum(["human", "agent", "scheduler", "system"]),
});

const actorGrantSchema = z.discriminatedUnion("kind", [
  actorGrantBase.extend({
    id: z.string().min(1).max(256),
    kind: z.literal("exact"),
    principal: z.string().min(1).max(256),
  }),
  actorGrantBase.extend({
    idPrefix: z.string().min(1).max(128),
    kind: z.literal("paired_prefix"),
    principalPrefix: z.string().min(1).max(128),
  }),
]);

const grantClaimsSchema = z
  .strictObject({
    actor: actorGrantSchema,
    audience: z.string().min(1).max(256),
    expiresAt: z.number().int().positive(),
    grantId: z.string().min(1).max(128),
    issuedAt: z.number().int().nonnegative(),
    operations: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(128)
      .refine(canonicalStrings, "Grant operations must be canonical"),
    version: z.literal(GRANT_VERSION),
  })
  .refine(
    (claims) =>
      claims.expiresAt > claims.issuedAt &&
      claims.expiresAt - claims.issuedAt <= MAX_GRANT_LIFETIME_SECONDS,
    "Grant lifetime is invalid",
  );

interface RuntimeRpcActorGrantBase {
  readonly capabilities: readonly ActorCapability[];
  readonly client: string;
  readonly type: ActorType;
}

export type RuntimeRpcActorGrant =
  | (RuntimeRpcActorGrantBase & Readonly<{ id: string; kind: "exact"; principal: string }>)
  | (RuntimeRpcActorGrantBase &
      Readonly<{ idPrefix: string; kind: "paired_prefix"; principalPrefix: string }>);

export interface RuntimeRpcGrantClaims {
  readonly actor: RuntimeRpcActorGrant;
  readonly audience: string;
  readonly expiresAt: number;
  readonly grantId: string;
  readonly issuedAt: number;
  readonly operations: readonly RuntimeOperation[];
  readonly version: 1;
}

export interface RuntimeRpcAuthentication {
  readonly audience: string;
  readonly now?: () => Date;
  readonly secret: Uint8Array;
}

export interface VerifiedRuntimeRpcGrant {
  readonly claims: RuntimeRpcGrantClaims;
}

export type RuntimeRpcEnvironment = Readonly<Record<string, string | undefined>>;

const verifiedGrantContext = new AsyncLocalStorage<VerifiedRuntimeRpcGrant>();
const verifiedGrantTokens = new WeakMap<VerifiedRuntimeRpcGrant, string>();

export function parseRuntimeRpcSecret(value: string): Uint8Array {
  if (!BASE64URL.test(value)) {
    throw new RuntimeError("INVALID_REQUEST", "Runtime RPC auth secret must be base64url");
  }
  const secret = Buffer.from(value, "base64url");
  if (secret.length < 32 || secret.toString("base64url") !== value) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Runtime RPC auth secret must be canonical base64url encoding of at least 32 bytes",
    );
  }
  return secret;
}

export function runtimeRpcAuthenticationFromEnvironment(
  environment: RuntimeRpcEnvironment,
): RuntimeRpcAuthentication | undefined {
  if (allowsUnauthenticatedTestProcess(environment)) return undefined;
  return {
    audience: optionalNonEmptyEnvironment(
      environment,
      "ITERM_RPC_AUTH_AUDIENCE",
      DEFAULT_RUNTIME_RPC_AUDIENCE,
    ),
    secret: parseRuntimeRpcSecret(requiredEnvironment(environment, "ITERM_RPC_AUTH_SECRET")),
  };
}

export function runtimeRpcAuthorizationFromEnvironment(
  environment: RuntimeRpcEnvironment,
): string | undefined {
  if (allowsUnauthenticatedTestProcess(environment)) return undefined;
  return requiredEnvironment(environment, "ITERM_RPC_GRANT");
}

export function signRuntimeRpcGrant(secret: Uint8Array, claims: RuntimeRpcGrantClaims): string {
  requireSecret(secret);
  const parsed = parseClaims(claims);
  const encodedClaims = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedClaims, "ascii").digest("base64url");
  return `${encodedClaims}.${signature}`;
}

export function verifyRuntimeRpcGrant(
  token: string,
  authentication: RuntimeRpcAuthentication,
  allowedOperations: ReadonlySet<RuntimeOperation>,
): VerifiedRuntimeRpcGrant {
  try {
    requireSecret(authentication.secret);
    if (Buffer.byteLength(token, "utf8") > MAX_GRANT_BYTES) throw new Error("oversize");
    const segments = token.split(".");
    if (
      segments.length !== 2 ||
      segments[0] === undefined ||
      segments[1] === undefined ||
      !BASE64URL.test(segments[0]) ||
      !BASE64URL.test(segments[1])
    ) {
      throw new Error("format");
    }
    const encodedClaims = Buffer.from(segments[0], "base64url");
    const actual = Buffer.from(segments[1], "base64url");
    if (
      encodedClaims.toString("base64url") !== segments[0] ||
      actual.toString("base64url") !== segments[1]
    ) {
      throw new Error("encoding");
    }
    const expected = createHmac("sha256", authentication.secret)
      .update(segments[0], "ascii")
      .digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("signature");
    }
    const claims = parseClaims(JSON.parse(encodedClaims.toString("utf8")));
    if (claims.audience !== authentication.audience) throw new Error("audience");
    if (!claims.operations.every((operation) => allowedOperations.has(operation))) {
      throw new Error("operation");
    }
    const now = Math.floor((authentication.now?.() ?? new Date()).getTime() / 1_000);
    if (claims.issuedAt > now + CLOCK_SKEW_SECONDS || claims.expiresAt <= now) {
      throw new Error("time");
    }
    const grant: VerifiedRuntimeRpcGrant = { claims };
    verifiedGrantTokens.set(grant, token);
    return grant;
  } catch {
    throw authorizationFailed();
  }
}

export function authorizeRuntimeRpcGrant(
  grant: VerifiedRuntimeRpcGrant,
  operation: RuntimeOperation,
  actor?: Actor,
): void {
  if (!grant.claims.operations.includes(operation)) throw authorizationFailed();
  if (actor === undefined) return;
  const allowed = grant.claims.actor;
  if (
    actor.type !== allowed.type ||
    actor.client !== allowed.client ||
    actor.capabilities.length !== allowed.capabilities.length ||
    !actor.capabilities.every((capability, index) => allowed.capabilities[index] === capability)
  ) {
    throw authorizationFailed();
  }
  if (allowed.kind === "exact") {
    if (actor.id !== allowed.id || actor.principal !== allowed.principal) {
      throw authorizationFailed();
    }
    return;
  }
  if (
    !actor.id.startsWith(allowed.idPrefix) ||
    !actor.principal.startsWith(allowed.principalPrefix)
  ) {
    throw authorizationFailed();
  }
  const idSuffix = actor.id.slice(allowed.idPrefix.length);
  const principalSuffix = actor.principal.slice(allowed.principalPrefix.length);
  if (idSuffix.length === 0 || idSuffix !== principalSuffix) throw authorizationFailed();
}

export function runWithVerifiedRuntimeRpcGrant<T>(
  grant: VerifiedRuntimeRpcGrant,
  work: () => Promise<T>,
): Promise<T> {
  return verifiedGrantContext.run(grant, work);
}

export function currentRuntimeRpcGrantToken(): string | undefined {
  const grant = verifiedGrantContext.getStore();
  return grant === undefined ? undefined : runtimeRpcGrantToken(grant);
}

/** Explicitly reserved for forwarding the active verified grant to another Runtime RPC hop. */
export function runtimeRpcGrantToken(grant: VerifiedRuntimeRpcGrant): string {
  const token = verifiedGrantTokens.get(grant);
  if (token === undefined) {
    throw new RuntimeError("POLICY_DENIED", "Runtime RPC authorization context is invalid");
  }
  return token;
}

function parseClaims(value: unknown): RuntimeRpcGrantClaims {
  return grantClaimsSchema.parse(value) as RuntimeRpcGrantClaims;
}

function canonicalStrings(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function requireSecret(secret: Uint8Array): void {
  if (secret.byteLength < 32) {
    throw new RuntimeError("INVALID_REQUEST", "Runtime RPC auth secret must contain 32 bytes");
  }
}

function authorizationFailed(): RuntimeError {
  return new RuntimeError("POLICY_DENIED", "Runtime RPC authorization failed");
}

function allowsUnauthenticatedTestProcess(environment: RuntimeRpcEnvironment): boolean {
  const requested = environment.ITERM_RPC_TEST_ALLOW_UNAUTHENTICATED;
  if (requested === undefined) return false;
  if (requested !== "1") {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "ITERM_RPC_TEST_ALLOW_UNAUTHENTICATED must be '1' when provided",
    );
  }
  if (environment.NODE_ENV !== "test") {
    throw new RuntimeError(
      "POLICY_DENIED",
      "Unauthenticated Runtime RPC is restricted to explicit test processes",
    );
  }
  return true;
}

function requiredEnvironment(environment: RuntimeRpcEnvironment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new RuntimeError("INVALID_REQUEST", `${name} is required`);
  }
  return value;
}

function optionalNonEmptyEnvironment(
  environment: RuntimeRpcEnvironment,
  name: string,
  fallback: string,
): string {
  const value = environment[name];
  if (value === undefined) return fallback;
  if (value.length === 0) {
    throw new RuntimeError("INVALID_REQUEST", `${name} cannot be empty`);
  }
  return value;
}
