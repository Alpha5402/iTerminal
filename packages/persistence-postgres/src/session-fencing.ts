import type { RuntimeOwnerIdentity, SessionFence, SessionLease } from "@iterminal/application";
import { RuntimeError } from "@iterminal/domain";
import type { PoolClient } from "pg";

export interface SessionLeaseRow {
  readonly acquired_at: Date;
  readonly fencing_token: string;
  readonly lease_expires_at: Date;
  readonly owner_id: string;
  readonly owner_instance_id: string;
  readonly owner_registry_epoch: string;
  readonly renewed_at: Date;
  readonly session_generation: number;
  readonly session_id: string;
  readonly version: string;
}

export async function assertRuntimeOwner(
  client: PoolClient,
  owner: RuntimeOwnerIdentity,
): Promise<{ readonly leaseExpiresAt: Date }> {
  const result = await client.query<{ lease_expires_at: Date }>(
    `SELECT lease_expires_at
       FROM runtime_workers
      WHERE owner_id = $1 AND instance_id = $2 AND registry_epoch = $3
        AND status IN ('ACTIVE', 'DRAINING') AND lease_expires_at > now()
      FOR UPDATE`,
    [owner.ownerId, owner.instanceId, owner.epoch],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RuntimeError(
      "OWNER_LEASE_LOST",
      "Runtime owner identity is not current for a fenced mutation",
      {
        ownerEpoch: owner.epoch,
        ownerId: owner.ownerId,
        ownerInstanceId: owner.instanceId,
      },
      false,
    );
  }
  return { leaseExpiresAt: row.lease_expires_at };
}

export async function createSessionLease(
  client: PoolClient,
  input: {
    readonly generation: number;
    readonly leaseMilliseconds: number;
    readonly owner: RuntimeOwnerIdentity;
    readonly sessionId: string;
  },
): Promise<SessionLease> {
  const leaseMilliseconds = positiveInteger(input.leaseMilliseconds, "leaseMilliseconds");
  const owner = await assertRuntimeOwner(client, input.owner);
  const result = await client.query<SessionLeaseRow>(
    `INSERT INTO session_leases
       (session_id, session_generation, owner_id, owner_instance_id,
        owner_registry_epoch, acquired_at, renewed_at, lease_expires_at)
     VALUES ($1, $2, $3, $4, $5, now(), now(),
             LEAST($6::timestamptz, now() + ($7::bigint * interval '1 millisecond')))
     RETURNING session_id, session_generation, owner_id, owner_instance_id,
               owner_registry_epoch::text, fencing_token::text, acquired_at,
               renewed_at, lease_expires_at, version::text`,
    [
      input.sessionId,
      input.generation,
      input.owner.ownerId,
      input.owner.instanceId,
      input.owner.epoch,
      owner.leaseExpiresAt,
      leaseMilliseconds,
    ],
  );
  return sessionLease(requiredRow(result.rows[0], "Session lease was not created"));
}

export async function assertSessionFence(
  client: PoolClient,
  fence: SessionFence,
): Promise<SessionLease> {
  try {
    await assertRuntimeOwner(client, fence);
  } catch (error) {
    if (error instanceof RuntimeError && error.code === "OWNER_LEASE_LOST") {
      throwSessionLeaseLost(fence);
    }
    throw error;
  }
  const result = await client.query<SessionLeaseRow>(
    `SELECT lease.session_id, lease.session_generation, lease.owner_id,
            lease.owner_instance_id, lease.owner_registry_epoch::text,
            lease.fencing_token::text, lease.acquired_at, lease.renewed_at,
            lease.lease_expires_at, lease.version::text
       FROM session_leases lease
      WHERE lease.session_id = $1 AND lease.session_generation = $2
        AND lease.owner_id = $3 AND lease.owner_instance_id = $4
        AND lease.owner_registry_epoch = $5 AND lease.fencing_token = $6
        AND lease.released_at IS NULL AND lease.lease_expires_at > now()
      FOR UPDATE OF lease`,
    [
      fence.sessionId,
      fence.generation,
      fence.ownerId,
      fence.instanceId,
      fence.epoch,
      fence.fencingToken,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throwSessionLeaseLost(fence);
  return sessionLease(requiredRow(row, "Session fence disappeared after validation"));
}

export async function releaseSessionLease(
  client: PoolClient,
  fence: SessionFence,
  reason: string,
): Promise<void> {
  await assertSessionFence(client, fence);
  const released = await client.query(
    `UPDATE session_leases
        SET released_at = now(), release_reason = $7, lease_expires_at = now(),
            version = version + 1
      WHERE session_id = $1 AND session_generation = $2 AND owner_id = $3
        AND owner_instance_id = $4 AND owner_registry_epoch = $5
        AND fencing_token = $6 AND released_at IS NULL`,
    [
      fence.sessionId,
      fence.generation,
      fence.ownerId,
      fence.instanceId,
      fence.epoch,
      fence.fencingToken,
      reason,
    ],
  );
  if (released.rowCount !== 1) throwSessionLeaseLost(fence);
}

export function sessionLease(row: SessionLeaseRow): SessionLease {
  return {
    acquiredAt: row.acquired_at.toISOString(),
    epoch: Number.parseInt(row.owner_registry_epoch, 10),
    fencingToken: row.fencing_token,
    generation: row.session_generation,
    instanceId: row.owner_instance_id,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
    ownerId: row.owner_id,
    renewedAt: row.renewed_at.toISOString(),
    sessionId: row.session_id,
    version: Number.parseInt(row.version, 10),
  };
}

export function throwSessionLeaseLost(fence: SessionFence): never {
  throw new RuntimeError(
    "SESSION_LEASE_LOST",
    "Session generation lease is expired, released, or owned by another Runtime incarnation",
    {
      fencingToken: fence.fencingToken,
      generation: fence.generation,
      ownerEpoch: fence.epoch,
      ownerId: fence.ownerId,
      ownerInstanceId: fence.instanceId,
      sessionId: fence.sessionId,
    },
    false,
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeError("INVALID_REQUEST", `${name} must be a positive integer`, {
      [name]: value,
    });
  }
  return value;
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) throw new RuntimeError("RUNTIME_UNAVAILABLE", message, {}, true);
  return row;
}
