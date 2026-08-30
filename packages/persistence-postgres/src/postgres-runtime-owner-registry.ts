import type {
  RuntimeOwnerIdentity,
  RuntimeOwnerRecord,
  RuntimeOwnerRegistry,
  RuntimeOwnerRoute,
  RuntimeOwnerStatus,
  RuntimeRouteResolution,
  SessionCreationClaim,
} from "@iterminal/application";
import { RuntimeError } from "@iterminal/domain";
import type { Pool, PoolClient } from "pg";

import { migrateDatabase } from "./migrate.js";
import {
  createPostgresEndpointPool,
  type PostgresConnectionTarget,
  type PostgresEndpointPool,
} from "./postgres-endpoints.js";
import {
  assertSessionCreationCapacity,
  lockSessionPlacement,
  prepareSessionCreationAdmission,
} from "./session-creation-retention.js";

interface OwnerRow {
  readonly active_session_count: string;
  readonly capacity_weight: number;
  readonly endpoint: string;
  readonly heartbeat_at: Date;
  readonly instance_id: string;
  readonly lease_expires_at: Date;
  readonly owner_id: string;
  readonly placement_count: string;
  readonly registry_epoch: string;
  readonly started_at: Date;
  readonly status: RuntimeOwnerStatus;
  readonly stopped_at: Date | null;
  readonly version: string;
}

interface SessionCreationRow {
  readonly idempotency_key: string;
  readonly owner_id: string;
  readonly owner_instance_id: string;
  readonly owner_registry_epoch: string;
  readonly request_hash: string;
  readonly session_id: string | null;
}

type RouteRow = Readonly<{ target_owner_id: string }> & {
  readonly [Key in keyof OwnerRow]: OwnerRow[Key] | null;
};

function ownerColumns(alias: string, includeActiveSessionCount = true): string {
  return `${alias}.owner_id, ${alias}.instance_id, ${alias}.registry_epoch::text,
  ${alias}.endpoint, ${alias}.status, ${alias}.heartbeat_at, ${alias}.lease_expires_at,
  ${alias}.started_at, ${alias}.stopped_at, ${alias}.version::text,
  ${alias}.capacity_weight,
  ${
    includeActiveSessionCount
      ? `(SELECT count(*)::text FROM sessions s
    WHERE s.owner_id = ${alias}.owner_id
      AND s.status IN ('STARTING', 'READY', 'RESERVED', 'RUNNING'))`
      : "0::text"
  } AS active_session_count, ${alias}.placement_count::text`;
}

const OWNER_RETURNING = ownerColumns("runtime_workers");
export interface PostgresRuntimeOwnerRegistryOptions {
  readonly statementTimeoutMilliseconds?: number;
}

export class PostgresRuntimeOwnerRegistry implements RuntimeOwnerRegistry {
  readonly #pool: Pool;
  readonly #endpoints: PostgresEndpointPool;

  public constructor(
    connectionString: PostgresConnectionTarget,
    options: PostgresRuntimeOwnerRegistryOptions = {},
  ) {
    const statementTimeoutMilliseconds = positiveInteger(
      options.statementTimeoutMilliseconds ?? 30_000,
      "statementTimeoutMilliseconds",
    );
    this.#endpoints = createPostgresEndpointPool(connectionString, {
      connectionTimeoutMillis: 5_000,
      max: 5,
      query_timeout: statementTimeoutMilliseconds,
      statement_timeout: statementTimeoutMilliseconds,
    });
    this.#pool = this.#endpoints.pool;
  }

  public async migrate(): Promise<void> {
    await migrateDatabase(this.#pool);
  }

  public async healthCheck(): Promise<void> {
    await this.#pool.query("SELECT 1");
  }

  public databaseEndpointIndex(): number {
    return this.#endpoints.endpointIndex();
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }

  public async registerOwner(input: {
    readonly capacityWeight?: number;
    readonly endpoint: string;
    readonly instanceId: string;
    readonly leaseMilliseconds: number;
    readonly ownerId: string;
  }): Promise<RuntimeOwnerRecord> {
    validateIdentifier(input.ownerId, "ownerId");
    validateIdentifier(input.instanceId, "instanceId");
    validateEndpoint(input.endpoint);
    const leaseMilliseconds = positiveInteger(input.leaseMilliseconds, "leaseMilliseconds");
    const capacityWeight = boundedCapacityWeight(input.capacityWeight ?? 1);
    const registered = await this.#pool.query<OwnerRow>(
      `INSERT INTO runtime_workers
         (owner_id, instance_id, registry_epoch, endpoint, status, heartbeat_at,
          lease_expires_at, started_at, stopped_at, version, capacity_weight)
       VALUES ($1, $2, 1, $3, 'ACTIVE', now(),
               now() + ($4::bigint * interval '1 millisecond'), now(), NULL, 1, $5)
       ON CONFLICT (owner_id) DO UPDATE
         SET instance_id = EXCLUDED.instance_id,
             registry_epoch = CASE
               WHEN runtime_workers.instance_id = EXCLUDED.instance_id
                 THEN runtime_workers.registry_epoch
               ELSE runtime_workers.registry_epoch + 1
             END,
             endpoint = EXCLUDED.endpoint,
             capacity_weight = EXCLUDED.capacity_weight,
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
      [input.ownerId, input.instanceId, input.endpoint, leaseMilliseconds, capacityWeight],
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
          AND lease_expires_at > now()
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
        ORDER BY placement_count::numeric / capacity_weight, owner_id`,
    );
    return owners.rows.map(ownerRecord);
  }

  public async claimAssignableOwner(): Promise<RuntimeOwnerRecord | undefined> {
    return this.#transaction(async (client) => {
      await lockSessionPlacement(client);
      return this.#claimAssignableOwner(client);
    });
  }

  public async countPendingSessionCreations(identity: RuntimeOwnerIdentity): Promise<number> {
    validateIdentity(identity);
    const pending = await this.#pool.query<{ request_count: string }>(
      `SELECT count(*)::text AS request_count
         FROM session_creation_requests
        WHERE owner_id = $1
          AND owner_instance_id = $2
          AND owner_registry_epoch = $3
          AND session_id IS NULL`,
      [identity.ownerId, identity.instanceId, identity.epoch],
    );
    const requestCount = Number(pending.rows[0]?.request_count);
    if (!Number.isSafeInteger(requestCount) || requestCount < 0) {
      throw new RuntimeError(
        "RUNTIME_UNAVAILABLE",
        "Pending Session creation count is invalid",
        { ownerId: identity.ownerId, requestCount: pending.rows[0]?.request_count },
        true,
      );
    }
    return requestCount;
  }

  public async claimSessionCreation(input: {
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<SessionCreationClaim | undefined> {
    validateIdentifier(input.idempotencyKey, "idempotencyKey");
    validateRequestHash(input.requestHash);
    return this.#transaction(async (client) => {
      const policy = await prepareSessionCreationAdmission(client);
      const existing = await client.query<SessionCreationRow>(
        `SELECT idempotency_key, request_hash, owner_id, owner_instance_id,
                owner_registry_epoch::text, session_id
           FROM session_creation_requests
          WHERE idempotency_key = $1
          FOR UPDATE`,
        [input.idempotencyKey],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (replay.request_hash !== input.requestHash) {
          throw new RuntimeError(
            "IDEMPOTENCY_KEY_REUSED",
            "Session creation idempotency key was already used with a different request",
            { idempotencyKey: input.idempotencyKey },
          );
        }
        const owner =
          replay.session_id === null
            ? await client.query<OwnerRow>(
                `SELECT ${OWNER_RETURNING}
                   FROM runtime_workers
                  WHERE owner_id = $1 AND instance_id = $2 AND registry_epoch = $3
                    AND status IN ('ACTIVE', 'DRAINING') AND lease_expires_at > now()`,
                [replay.owner_id, replay.owner_instance_id, replay.owner_registry_epoch],
              )
            : await client.query<OwnerRow>(
                `SELECT ${OWNER_RETURNING}
                   FROM sessions session
                   JOIN runtime_workers ON runtime_workers.owner_id = session.owner_id
                  WHERE session.id = $1
                    AND runtime_workers.status IN ('ACTIVE', 'DRAINING')
                    AND runtime_workers.lease_expires_at > now()`,
                [replay.session_id],
              );
        const row = owner.rows[0];
        if (row === undefined) {
          throw new RuntimeError(
            "OWNER_ROUTE_UNAVAILABLE",
            replay.session_id === null
              ? "Session creation intent has no live exact owner route"
              : "Created Session has no live owner route",
            {
              idempotencyKey: input.idempotencyKey,
              ownerEpoch: Number.parseInt(replay.owner_registry_epoch, 10),
              ownerId: replay.owner_id,
              ownerInstanceId: replay.owner_instance_id,
              sessionId: replay.session_id ?? undefined,
            },
            true,
          );
        }
        return {
          owner: ownerRoute(row),
          ...(replay.session_id === null ? {} : { sessionId: replay.session_id }),
        };
      }

      await assertSessionCreationCapacity(client, policy);
      const owner = await this.#claimAssignableOwner(client);
      if (owner === undefined) return undefined;
      await client.query(
        `INSERT INTO session_creation_requests
          (idempotency_key, request_hash, owner_id, owner_instance_id, owner_registry_epoch)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.idempotencyKey, input.requestHash, owner.ownerId, owner.instanceId, owner.epoch],
      );
      return { owner: ownerRouteFromRecord(owner) };
    });
  }

  public async listSessionOwnerRoutes(): Promise<readonly RuntimeRouteResolution[]> {
    const routes = await this.#pool.query<RouteRow>(
      `SELECT target.owner_id AS target_owner_id, ${ownerColumns("worker", false)}
         FROM (
           SELECT DISTINCT owner_id
             FROM sessions
            WHERE status IN ('STARTING', 'READY', 'RESERVED', 'RUNNING', 'BROKEN')
         ) target
         LEFT JOIN runtime_workers worker
           ON worker.owner_id = target.owner_id
          AND worker.status IN ('ACTIVE', 'DRAINING')
          AND worker.lease_expires_at > now()
        ORDER BY target.owner_id`,
    );
    return routes.rows.map(routeResolution);
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

  public resolveSessionRoute(sessionId: string): Promise<RuntimeRouteResolution | undefined> {
    validateIdentifier(sessionId, "sessionId");
    return this.#resolveTargetRoute("sessions", sessionId);
  }

  public resolveExecutionRoute(executionId: string): Promise<RuntimeRouteResolution | undefined> {
    validateIdentifier(executionId, "executionId");
    return this.#resolveTargetRoute("executions", executionId);
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
          AND lease_expires_at > now()
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
      `Runtime owner cannot ${operation} after its registry identity changed or expired`,
      {
        attemptedEpoch: identity.epoch,
        attemptedInstanceId: identity.instanceId,
        currentEpoch: current?.epoch,
        currentInstanceId: current?.instanceId,
        currentLeaseExpiresAt: current?.leaseExpiresAt,
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

  async #resolveTargetRoute(
    target: "executions" | "sessions",
    targetId: string,
  ): Promise<RuntimeRouteResolution | undefined> {
    const route = await this.#pool.query<RouteRow>(
      `SELECT target.owner_id AS target_owner_id, ${ownerColumns("worker", false)}
         FROM ${target} target
         LEFT JOIN runtime_workers worker
           ON worker.owner_id = target.owner_id
          AND worker.status IN ('ACTIVE', 'DRAINING')
          AND worker.lease_expires_at > now()
        WHERE target.id = $1`,
      [targetId],
    );
    const row = route.rows[0];
    return row === undefined ? undefined : routeResolution(row);
  }

  async #transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #claimAssignableOwner(client: PoolClient): Promise<RuntimeOwnerRecord | undefined> {
    const candidate = await client.query<{ owner_id: string }>(
      `SELECT owner_id
         FROM runtime_workers
        WHERE status = 'ACTIVE' AND lease_expires_at > now()
        ORDER BY placement_count::numeric / capacity_weight, owner_id
        LIMIT 1
        FOR UPDATE`,
    );
    const ownerId = candidate.rows[0]?.owner_id;
    if (ownerId === undefined) return undefined;
    const claimed = await client.query<OwnerRow>(
      `UPDATE runtime_workers
          SET placement_count = placement_count + 1,
              version = version + 1
        WHERE owner_id = $1 AND status = 'ACTIVE' AND lease_expires_at > now()
      RETURNING ${OWNER_RETURNING}`,
      [ownerId],
    );
    const row = claimed.rows[0];
    if (row === undefined) {
      throw new RuntimeError(
        "RUNTIME_UNAVAILABLE",
        "Assignable Runtime owner changed during its atomic placement claim",
        { ownerId },
        true,
      );
    }
    return ownerRecord(row);
  }
}

function ownerRecord(row: OwnerRow): RuntimeOwnerRecord {
  return {
    activeSessionCount: Number.parseInt(row.active_session_count, 10),
    capacityWeight: row.capacity_weight,
    endpoint: row.endpoint,
    epoch: Number.parseInt(row.registry_epoch, 10),
    heartbeatAt: row.heartbeat_at.toISOString(),
    instanceId: row.instance_id,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
    ownerId: row.owner_id,
    placementCount: Number.parseInt(row.placement_count, 10),
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

function boundedCapacityWeight(value: number): number {
  const weight = positiveInteger(value, "capacityWeight");
  if (weight > 1_000) {
    throw new RuntimeError("INVALID_REQUEST", "capacityWeight must be at most 1000", {
      capacityWeight: value,
    });
  }
  return weight;
}

function unreachableOwnerRow(): never {
  throw new Error("Runtime owner update returned no row after lease validation");
}

function requiredOwnerRow(row: RouteRow): OwnerRow {
  if (
    row.active_session_count === null ||
    row.capacity_weight === null ||
    row.endpoint === null ||
    row.heartbeat_at === null ||
    row.instance_id === null ||
    row.lease_expires_at === null ||
    row.owner_id === null ||
    row.placement_count === null ||
    row.registry_epoch === null ||
    row.started_at === null ||
    row.status === null ||
    row.version === null
  ) {
    throw new RuntimeError(
      "RUNTIME_UNAVAILABLE",
      "Runtime owner route returned incomplete registry data",
    );
  }
  return {
    active_session_count: row.active_session_count,
    capacity_weight: row.capacity_weight,
    endpoint: row.endpoint,
    heartbeat_at: row.heartbeat_at,
    instance_id: row.instance_id,
    lease_expires_at: row.lease_expires_at,
    owner_id: row.owner_id,
    placement_count: row.placement_count,
    registry_epoch: row.registry_epoch,
    started_at: row.started_at,
    status: row.status,
    stopped_at: row.stopped_at,
    version: row.version,
  };
}

function routeResolution(row: RouteRow): RuntimeRouteResolution {
  if (row.owner_id === null) return { ownerId: row.target_owner_id };
  return {
    liveOwner: ownerRoute(requiredOwnerRow(row)),
    ownerId: row.target_owner_id,
  };
}

function ownerRoute(row: OwnerRow): RuntimeOwnerRoute {
  return {
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

function ownerRouteFromRecord(owner: RuntimeOwnerRecord): RuntimeOwnerRoute {
  return {
    endpoint: owner.endpoint,
    epoch: owner.epoch,
    heartbeatAt: owner.heartbeatAt,
    instanceId: owner.instanceId,
    leaseExpiresAt: owner.leaseExpiresAt,
    ownerId: owner.ownerId,
    startedAt: owner.startedAt,
    status: owner.status,
    version: owner.version,
    ...(owner.stoppedAt === undefined ? {} : { stoppedAt: owner.stoppedAt }),
  };
}

function validateRequestHash(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new RuntimeError("INVALID_REQUEST", "requestHash must be a lowercase SHA-256 digest");
  }
}
import { isAbsolute } from "node:path";
