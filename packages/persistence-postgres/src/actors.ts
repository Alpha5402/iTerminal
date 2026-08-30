import type { Actor, ActorCapability, ActorType } from "@iterminal/domain";
import { ACTOR_CAPABILITIES, RuntimeError, isCanonicalActorCapabilities } from "@iterminal/domain";
import type { PoolClient } from "pg";

interface ActorRow {
  readonly actor_type: string;
  readonly capabilities: string[];
  readonly client: string;
  readonly id: string;
  readonly principal: string;
}

export async function persistActor(client: PoolClient, actor: Actor): Promise<void> {
  assertCanonicalActor(actor);
  const inserted = await client.query(
    `INSERT INTO actors (id, actor_type, principal, client, capabilities)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [actor.id, actor.type, actor.principal, actor.client, actor.capabilities],
  );
  if (inserted.rowCount === 1) return;

  const existing = await client.query<ActorRow>(
    `SELECT id, actor_type, principal, client, capabilities
       FROM actors
      WHERE id = $1`,
    [actor.id],
  );
  const row = existing.rows[0];
  if (row !== undefined && sameActorRow(row, actor)) return;
  throw new RuntimeError(
    "ACTOR_IDENTITY_CONFLICT",
    "Actor id is already bound to a different immutable identity",
    { actorId: actor.id },
  );
}

export function actorFromRow(
  row: Readonly<{
    readonly actor_id: string;
    readonly actor_type: string;
    readonly capabilities: string[];
    readonly client: string;
    readonly principal: string;
  }>,
): Actor {
  const type = actorType(row.actor_type);
  const capabilities = actorCapabilities(row.capabilities);
  return {
    capabilities,
    client: row.client,
    id: row.actor_id,
    principal: row.principal,
    type,
  };
}

function assertCanonicalActor(actor: Actor): void {
  if (!isCanonicalActorCapabilities(actor.capabilities)) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Actor capabilities must be a non-empty canonical set",
      { actorId: actor.id },
    );
  }
}

function sameActorRow(row: ActorRow, actor: Actor): boolean {
  return (
    row.actor_type === actor.type &&
    row.principal === actor.principal &&
    row.client === actor.client &&
    row.capabilities.length === actor.capabilities.length &&
    row.capabilities.every((capability, index) => actor.capabilities[index] === capability)
  );
}

function actorType(value: string): ActorType {
  if (value === "human" || value === "agent" || value === "scheduler" || value === "system") {
    return value;
  }
  throw new RuntimeError("RUNTIME_UNAVAILABLE", "Durable Actor type is invalid", {
    actorType: value,
  });
}

function actorCapabilities(values: readonly string[]): readonly ActorCapability[] {
  if (
    !values.every((value): value is ActorCapability =>
      ACTOR_CAPABILITIES.includes(value as ActorCapability),
    ) ||
    !isCanonicalActorCapabilities(values)
  ) {
    throw new RuntimeError("RUNTIME_UNAVAILABLE", "Durable Actor capabilities are invalid");
  }
  return values;
}
