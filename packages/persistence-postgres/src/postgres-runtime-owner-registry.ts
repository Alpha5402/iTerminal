import type {
  RuntimeOwnerIdentity,
  RuntimeOwnerRecord,
  RuntimeOwnerRegistry,
  RuntimeOwnerStatus,
} from "@iterminal/application";
import { RuntimeError } from "@iterminal/domain";
import { Pool } from "pg";

import { migrateDatabase } from "./migrate.js";
import { guardPostgresPool } from "./postgres-pool.js";

interface OwnerRow {
  readonly active_session_count: string;
  readonly endpoint: string;
  readonly heartbeat_at: Date;
  readonly instance_id: string;
  readonly lease_expires_at: Date;
  readonly owner_id: string;
  readonly registry_epoch: string;
  readonly started_at: Date;
  readonly status: RuntimeOwnerStatus;
  readonly stopped_at: Date | null;
  readonly version: string;
}

const OWNER_RETURNING = `owner_id, instance_id, registry_epoch::text, endpoint, status,
  heartbeat_at, lease_expires_at, started_at, stopped_at, version::text,
  (SELECT count(*)::text FROM sessions s
    WHERE s.owner_id = runtime_workers.owner_id
      AND s.status IN ('STARTING', 'READY', 'RESERVED', 'RUNNING')) AS active_session_count`;

export interface PostgresRuntimeOwnerRegistryOptions {
  readonly statementTimeoutMilliseconds?: number;
}

export class PostgresRuntimeOwnerRegistry implements RuntimeOwnerRegistry {
  readonly #pool: Pool;

  public constructor(connectionString: string, options: PostgresRuntimeOwnerRegistryOptions = {}) {
    const statementTimeoutMilliseconds = positiveInteger(
      options.statementTimeoutMilliseconds ?? 30_000,
      "statementTimeoutMilliseconds",
    );
    this.#pool = guardPostgresPool(
      new Pool({
        connectionString,
        connectionTimeoutMillis: 5_000,
        max: 5,
        query_timeout: statementTimeoutMilliseconds,
        statement_timeout: statementTimeoutMilliseconds,
      }),
    );
  }

  public async migrate(): Promise<void> {
    await migrateDatabase(this.#pool);
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }

  public async registerOwner(input: {
    readonly endpoint: string;
    readonly instanceId: string;
    readonly leaseMilliseconds: number;
    readonly ownerId: string;
  }): Promise<RuntimeOwnerRecord> {
    validateIdentifier(input.ownerId, "ownerId");
    validateIdentifier(input.instanceId, "instanceId");
    validateEndpoint(input.endpoint);
    const leaseMilliseconds = positiveInteger(input.leaseMilliseconds, "leaseMilliseconds");
    const registered = await this.#pool.query<OwnerRow>(
      `INSERT INTO runtime_workers
         (owner_id, instance_id, registry_epoch, endpoint, status, heartbeat_at,
          lease_expires_at, started_at, stopped_at, version)
       VALUES ($1, $2, 1, $3, 'ACTIVE', now(),
               now() + ($4::bigint * interval '1 millisecond'), now(), NULL, 1)
       ON CONFLICT (owner_id) DO UPDATE
         SET instance_id = EXCLUDED.instance_id,
             registry_epoch = CASE
               WHEN runtime_workers.instance_id = EXCLUDED.instance_id
                 THEN runtime_workers.registry_epoch
               ELSE runtime_workers.registry_epoch + 1
             END,
             endpoint = EXCLUDED.endpoint,
             status = CASE
               WHEN runtime_workers.instance_id = EXCLUDED.instance_id
                 THEN runtime_workers.status
               ELSE 'ACTIVE'
             END,
             heartbeat_at = now(),
             lease_expires_at = now() + ($4::bigint * interval '1 millisecond'),
             started_at = CASE
               WHEN runtime_workers.instance_id = EXCLUDED.instance_id
                 THEN runtime_workers.started_at
               ELSE now()
             END,
             stopped_at = NULL,
             version = runtime_workers.version + 1
       WHERE
         (runtime_workers.instance_id = EXCLUDED.instance_id
           AND runtime_workers.endpoint = EXCLUDED.endpoint
           AND runtime_workers.status <> 'STOPPED')
         OR
         (runtime_workers.instance_id <> EXCLUDED.instance_id
           AND (runtime_workers.status = 'STOPPED' OR runtime_workers.lease_expires_at <= now()))
       RETURNING ${OWNER_RETURNING}`,
      [input.ownerId, input.instanceId, input.endpoint, leaseMilliseconds],
    );
    const row = registered.rows[0];
    if (row !== undefined) return ownerRecord(row);
    const current = await this.#currentOwner(input.ownerId);
    throw new RuntimeError(
      current?.instanceId === input.instanceId ? "OWNER_LEASE_LOST" : "OWNER_CONFLICT",
      current?.instanceId === input.instanceId
        ? "Runtime owner instance can no longer register this route"
        : "Another live Runtime instance already owns this route",
      {
        attemptedEndpoint: input.endpoint,
        attemptedInstanceId: input.instanceId,
        currentEndpoint: current?.endpoint,
        currentEpoch: current?.epoch,
        currentInstanceId: current?.instanceId,
        currentStatus: current?.status,
        leaseExpiresAt: current?.leaseExpiresAt,
        ownerId: input.ownerId,
      },
      true,
    );
  }

  public heartbeatOwner(
    identity: RuntimeOwnerIdentity,
    leaseMilliseconds: number,
  ): Promise<RuntimeOwnerRecord> {
    return this.#updateLease(identity, leaseMilliseconds, "heartbeat");
  }

  public beginOwnerDrain(
    identity: RuntimeOwnerIdentity,
    leaseMilliseconds: number,
  ): Promise<RuntimeOwnerRecord> {
    return this.#updateLease(identity, leaseMilliseconds, "drain");
  }

  public async stopOwner(identity: RuntimeOwnerIdentity): Promise<RuntimeOwnerRecord> {
    validateIdentity(identity);
    const stopped = await this.#pool.query<OwnerRow>(
      `UPDATE runtime_workers
          SET status = 'STOPPED', heartbeat_at = now(), lease_expires_at = now(),
              stopped_at = now(), version = version + 1
        WHERE owner_id = $1 AND instance_id = $2 AND registry_epoch = $3
          AND status IN ('ACTIVE', 'DRAINING')
      RETURNING ${OWNER_RETURNING}`,
      [identity.ownerId, identity.instanceId, identity.epoch],
    );
    const row = stopped.rows[0];
    if (row === undefined) await this.#throwLeaseLost(identity, "stop");
    return ownerRecord(row ?? unreachableOwnerRow());
  }

  public async listAssignableOwners(): Promise<readonly RuntimeOwnerRecord[]> {
    const owners = await this.#pool.query<OwnerRow>(
      `SELECT ${OWNER_RETURNING}
        FROM runtime_workers
       WHERE status = 'ACTIVE' AND lease_expires_at > now()
        ORDER BY 11, owner_id`,
    );
    return owners.rows.map(ownerRecord);
  }

  public async resolveLiveOwner(ownerId: string): Promise<RuntimeOwnerRecord | undefined> {
    validateIdentifier(ownerId, "ownerId");
    const owner = await this.#pool.query<OwnerRow>(
      `SELECT ${OWNER_RETURNING}
         FROM runtime_workers
        WHERE owner_id = $1 AND status IN ('ACTIVE', 'DRAINING')
          AND lease_expires_at > now()`,
      [ownerId],
    );
    const row = owner.rows[0];
    return row === undefined ? undefined : ownerRecord(row);
  }

  async #updateLease(
    identity: RuntimeOwnerIdentity,
    leaseMilliseconds: number,
    operation: "drain" | "heartbeat",
  ): Promise<RuntimeOwnerRecord> {
    validateIdentity(identity);
    const duration = positiveInteger(leaseMilliseconds, "leaseMilliseconds");
    const updated = await this.#pool.query<OwnerRow>(
      `UPDATE runtime_workers
          SET status = CASE WHEN $5 = 'drain' THEN 'DRAINING' ELSE status END,
              heartbeat_at = now(),
              lease_expires_at = now() + ($4::bigint * interval '1 millisecond'),
              version = version + 1
        WHERE owner_id = $1 AND instance_id = $2 AND registry_epoch = $3
          AND status IN ('ACTIVE', 'DRAINING')
      RETURNING ${OWNER_RETURNING}`,
      [identity.ownerId, identity.instanceId, identity.epoch, duration, operation],
    );
    const row = updated.rows[0];
    if (row === undefined) await this.#throwLeaseLost(identity, operation);
    return ownerRecord(row ?? unreachableOwnerRow());
  }

  async #throwLeaseLost(identity: RuntimeOwnerIdentity, operation: string): Promise<never> {
    const current = await this.#currentOwner(identity.ownerId);
    throw new RuntimeError(
      "OWNER_LEASE_LOST",
      `Runtime owner cannot ${operation} after its registry identity changed`,
      {
        attemptedEpoch: identity.epoch,
        attemptedInstanceId: identity.instanceId,
        currentEpoch: current?.epoch,
        currentInstanceId: current?.instanceId,
        currentStatus: current?.status,
        ownerId: identity.ownerId,
      },
      false,
    );
  }

  async #currentOwner(ownerId: string): Promise<RuntimeOwnerRecord | undefined> {
    const owner = await this.#pool.query<OwnerRow>(
      `SELECT ${OWNER_RETURNING} FROM runtime_workers WHERE owner_id = $1`,
      [ownerId],
    );
    const row = owner.rows[0];
    return row === undefined ? undefined : ownerRecord(row);
  }
}

function ownerRecord(row: OwnerRow): RuntimeOwnerRecord {
  return {
    activeSessionCount: Number.parseInt(row.active_session_count, 10),
    endpoint: row.endpoint,
    epoch: Number.parseInt(row.registry_epoch, 10),
    heartbeatAt: row.heartbeat_at.toISOString(),
    instanceId: row.instance_id,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
    ownerId: row.owner_id,
    startedAt: row.started_at.toISOString(),
    status: row.status,
    version: Number.parseInt(row.version, 10),
    ...(row.stopped_at === null ? {} : { stoppedAt: row.stopped_at.toISOString() }),
  };
}

function validateIdentity(identity: RuntimeOwnerIdentity): void {
  validateIdentifier(identity.ownerId, "ownerId");
  validateIdentifier(identity.instanceId, "instanceId");
  positiveInteger(identity.epoch, "epoch");
}

function validateIdentifier(value: string, name: string): void {
  const bytes = Buffer.byteLength(value);
  if (bytes < 1 || bytes > 256 || value.includes("\0")) {
    throw new RuntimeError("INVALID_REQUEST", `${name} must contain 1 to 256 non-NUL bytes`);
  }
}

function validateEndpoint(value: string): void {
  const bytes = Buffer.byteLength(value);
  if (!isAbsolute(value) || bytes < 1 || bytes > 4_096 || value.includes("\0")) {
    throw new RuntimeError("INVALID_REQUEST", "Runtime owner endpoint is invalid");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeError("INVALID_REQUEST", `${name} must be a positive integer`, {
      [name]: value,
    });
  }
  return value;
}

function unreachableOwnerRow(): never {
  throw new Error("Runtime owner update returned no row after lease validation");
}
import { isAbsolute } from "node:path";
