import { RuntimeError } from "@iterminal/domain";
import type { Pool, PoolClient } from "pg";

import { createPostgresEndpointPool, type PostgresConnectionTarget } from "./postgres-endpoints.js";
import { migrateDatabase } from "./migrate.js";

const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

export interface DurableFactRetentionPolicy {
  readonly cleanupBatchSize: number;
  readonly retentionMilliseconds: number;
  readonly updatedAt: string;
}

export interface DurableFactRetentionMaintenanceResult {
  readonly deletedActions: number;
  readonly deletedApprovals: number;
  readonly deletedInboxRows: number;
  readonly deletedOutboxRows: number;
  readonly policy: DurableFactRetentionPolicy;
}

export interface DatabaseCapacityPolicy {
  readonly maxBytes: number;
  readonly updatedAt: string;
  readonly warningPercent: number;
}

export interface DatabaseCapacityState {
  readonly availableBytes: string;
  readonly policy: DatabaseCapacityPolicy;
  readonly status: "CRITICAL" | "HEALTHY" | "WARNING";
  readonly usedBytes: string;
  readonly usedPercent: number;
}

export interface PostgresStorageMaintenanceRepositoryOptions {
  readonly poolMax?: number;
  readonly statementTimeoutMilliseconds?: number;
}

interface RetentionPolicyRow {
  cleanup_batch_size: number;
  cutoff: Date;
  maintenance_time: Date;
  retention_milliseconds: string;
  updated_at: Date;
}

interface CapacityRow {
  max_bytes: string;
  updated_at: Date;
  used_bytes: string;
  warning_percent: number;
}

export class PostgresStorageMaintenanceRepository {
  readonly #pool: Pool;

  public constructor(
    connectionTarget: PostgresConnectionTarget,
    options: PostgresStorageMaintenanceRepositoryOptions = {},
  ) {
    const poolMax = positiveInteger(options.poolMax ?? 1, "poolMax");
    const statementTimeoutMilliseconds = positiveInteger(
      options.statementTimeoutMilliseconds ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      "statementTimeoutMilliseconds",
    );
    this.#pool = createPostgresEndpointPool(connectionTarget, {
      max: poolMax,
      query_timeout: statementTimeoutMilliseconds,
      statement_timeout: statementTimeoutMilliseconds,
    }).pool;
  }

  public async migrate(): Promise<void> {
    await migrateDatabase(this.#pool);
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }

  public async maintainDurableFacts(now?: Date): Promise<DurableFactRetentionMaintenanceResult> {
    if (now !== undefined && Number.isNaN(now.getTime())) {
      throw new RuntimeError("INVALID_REQUEST", "Durable fact retention time must be valid");
    }
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const policy = await lockRetentionPolicy(client, now);
      const deletedApprovals = await deleteApprovals(client, policy);
      const deletedOutboxRows = await deletePublishedOutbox(client, policy);
      const deletedInboxRows = await deleteCompletedInbox(client, policy);
      const deletedActions = await deleteTerminalActions(client, policy);
      await client.query("COMMIT");
      return {
        deletedActions,
        deletedApprovals,
        deletedInboxRows,
        deletedOutboxRows,
        policy: mapRetentionPolicy(policy),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async inspectDatabaseCapacity(): Promise<DatabaseCapacityState> {
    const result = await this.#pool.query<CapacityRow>(
      `SELECT policy.max_bytes::text, policy.warning_percent, policy.updated_at,
              pg_database_size(current_database())::text AS used_bytes
         FROM database_capacity_policies policy
        WHERE policy.scope = 'default'`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new RuntimeError("RUNTIME_UNAVAILABLE", "Database capacity policy is unavailable", {
        component: "database_capacity",
      });
    }
    const maxBytes = positiveSafeIntegerString(row.max_bytes, "Database capacity max bytes");
    const usedBytes = nonnegativeBigInt(row.used_bytes, "Database capacity used bytes");
    const maxBytesBigInt = BigInt(maxBytes);
    const warningPercent = boundedPercent(row.warning_percent);
    const status =
      usedBytes >= maxBytesBigInt
        ? "CRITICAL"
        : usedBytes * 100n >= maxBytesBigInt * BigInt(warningPercent)
          ? "WARNING"
          : "HEALTHY";
    const basisPoints =
      usedBytes >= maxBytesBigInt ? 10_000n : (usedBytes * 10_000n) / maxBytesBigInt;
    const usedPercent = Number(basisPoints) / 100;
    return {
      availableBytes: (usedBytes >= maxBytesBigInt ? 0n : maxBytesBigInt - usedBytes).toString(),
      policy: {
        maxBytes,
        updatedAt: row.updated_at.toISOString(),
        warningPercent,
      },
      status,
      usedBytes: usedBytes.toString(),
      usedPercent,
    };
  }
}

async function lockRetentionPolicy(
  client: PoolClient,
  now: Date | undefined,
): Promise<RetentionPolicyRow> {
  const result = await client.query<RetentionPolicyRow>(
    `SELECT retention_milliseconds::text, cleanup_batch_size, updated_at,
            coalesce($1::timestamptz, now()) AS maintenance_time,
            coalesce($1::timestamptz, now())
              - retention_milliseconds * interval '1 millisecond' AS cutoff
       FROM durable_fact_retention_policies
      WHERE scope = 'default'
      FOR UPDATE`,
    [now ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RuntimeError("RUNTIME_UNAVAILABLE", "Durable fact retention policy is unavailable", {
      component: "durable_fact_retention",
    });
  }
  return row;
}

async function deleteApprovals(client: PoolClient, policy: RetentionPolicyRow): Promise<number> {
  const result = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT approval.id
         FROM approvals approval
        WHERE coalesce(
                approval.consumed_at,
                approval.decided_at,
                approval.expires_at,
                approval.requested_at
              ) <= $1
          AND (
            approval.status IN ('DENIED', 'EXPIRED', 'CONSUMED')
            OR approval.expires_at <= $1
          )
        ORDER BY coalesce(
                   approval.consumed_at,
                   approval.decided_at,
                   approval.expires_at,
                   approval.requested_at
                 ), approval.id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM approvals approval
      USING candidates
      WHERE approval.id = candidates.id`,
    [policy.cutoff, policy.cleanup_batch_size],
  );
  return result.rowCount ?? 0;
}

async function deletePublishedOutbox(
  client: PoolClient,
  policy: RetentionPolicyRow,
): Promise<number> {
  const result = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT message.id
         FROM outbox message
        WHERE message.published_at <= $1
        ORDER BY message.published_at, message.id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM outbox message
      USING candidates
      WHERE message.id = candidates.id`,
    [policy.cutoff, policy.cleanup_batch_size],
  );
  return result.rowCount ?? 0;
}

async function deleteCompletedInbox(
  client: PoolClient,
  policy: RetentionPolicyRow,
): Promise<number> {
  const result = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT inbox.consumer_id, inbox.message_id
         FROM consumer_inbox inbox
        WHERE inbox.status = 'COMPLETED'
          AND inbox.completed_at <= $1
          AND NOT EXISTS (SELECT 1 FROM outbox message WHERE message.id = inbox.message_id)
        ORDER BY inbox.completed_at, inbox.consumer_id, inbox.message_id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM consumer_inbox inbox
      USING candidates
      WHERE inbox.consumer_id = candidates.consumer_id
        AND inbox.message_id = candidates.message_id`,
    [policy.cutoff, policy.cleanup_batch_size],
  );
  return result.rowCount ?? 0;
}

async function deleteTerminalActions(
  client: PoolClient,
  policy: RetentionPolicyRow,
): Promise<number> {
  const result = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT action.id, action.session_id, action.session_generation, action.actor_id,
              action.idempotency_key, action.request_hash, action.kind, action.status,
              action.accepted_at, execution.id AS execution_id,
              execution.status AS execution_status,
              execution.started_at AS execution_started_at,
              execution.finished_at AS execution_finished_at,
              execution.exit_code AS execution_exit_code
         FROM actions action
         JOIN sessions session ON session.id = action.session_id
         LEFT JOIN executions execution ON execution.action_id = action.id
        WHERE action.status IN (
                'COMPLETED', 'FAILED', 'INTERRUPTED', 'UNKNOWN',
                'DELIVERED', 'REJECTED', 'CANCELLED'
              )
          AND action.updated_at <= $1
          AND (
            action.session_generation <> session.current_generation
            OR session.status IN ('BROKEN', 'CLOSED')
          )
          AND (
            execution.id IS NULL
            OR session.active_execution_id IS DISTINCT FROM execution.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM session_events event
             WHERE event.action_id = action.id OR event.execution_id = execution.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM artifacts artifact WHERE artifact.execution_id = execution.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM session_snapshots snapshot
             WHERE snapshot.active_execution_id = execution.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM approvals approval WHERE approval.consumed_action_id = action.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM outbox message
             WHERE message.payload ->> 'executionId' = execution.id
          )
        ORDER BY action.updated_at, action.id
        LIMIT $2
        FOR UPDATE OF action SKIP LOCKED
     ), tombstoned AS (
       INSERT INTO action_history_tombstones
         (session_id, session_generation, actor_id, idempotency_key, request_hash,
          action_id, action_kind, action_status, accepted_at, execution_id,
          execution_status, execution_started_at, execution_finished_at,
          execution_exit_code, compacted_at)
       SELECT candidate.session_id, candidate.session_generation, candidate.actor_id,
              candidate.idempotency_key, candidate.request_hash, candidate.id,
              candidate.kind, candidate.status, candidate.accepted_at,
              candidate.execution_id, candidate.execution_status,
              candidate.execution_started_at, candidate.execution_finished_at,
              candidate.execution_exit_code, coalesce($3::timestamptz, now())
         FROM candidates candidate
       ON CONFLICT (session_id, actor_id, idempotency_key) DO UPDATE
         SET compacted_at = action_history_tombstones.compacted_at
       WHERE action_history_tombstones.action_id = EXCLUDED.action_id
         AND action_history_tombstones.request_hash = EXCLUDED.request_hash
       RETURNING action_id
     )
     DELETE FROM actions action
      USING candidates, tombstoned
      WHERE action.id = candidates.id
        AND tombstoned.action_id = candidates.id`,
    [policy.cutoff, policy.cleanup_batch_size, policy.maintenance_time],
  );
  return result.rowCount ?? 0;
}

function mapRetentionPolicy(row: RetentionPolicyRow): DurableFactRetentionPolicy {
  return {
    cleanupBatchSize: positiveInteger(row.cleanup_batch_size, "Durable fact cleanup batch size"),
    retentionMilliseconds: positiveSafeIntegerString(
      row.retention_milliseconds,
      "Durable fact retention milliseconds",
    ),
    updatedAt: row.updated_at.toISOString(),
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeError("INVALID_REQUEST", `${name} must be a positive safe integer`);
  }
  return value;
}

function positiveSafeIntegerString(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RuntimeError("RUNTIME_UNAVAILABLE", `${name} is invalid`, { component: name });
  }
  return parsed;
}

function nonnegativeBigInt(value: string, name: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new RuntimeError("RUNTIME_UNAVAILABLE", `${name} is invalid`, { component: name });
  }
  return BigInt(value);
}

function boundedPercent(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 99) {
    throw new RuntimeError("RUNTIME_UNAVAILABLE", "Database capacity warning percent is invalid", {
      component: "database_capacity",
    });
  }
  return value;
}
