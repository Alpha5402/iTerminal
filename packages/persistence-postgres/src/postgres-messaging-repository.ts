import { randomUUID } from "node:crypto";

import type {
  ClaimedOutboxMessage,
  ConsumerInbox,
  ExecutionReadyInspection,
  ExecutionReadyInspector,
  ExecutionReadyMessage,
  InboxAcquireResult,
  OutboxRepository,
} from "@iterminal/messaging";
import { RuntimeError } from "@iterminal/domain";
import type { Pool, PoolClient } from "pg";

import { migrateDatabase } from "./migrate.js";
import {
  createPostgresEndpointPool,
  type PostgresConnectionTarget,
  type PostgresEndpointPool,
} from "./postgres-endpoints.js";

export interface PostgresMessagingRepositoryOptions {
  readonly connectionTimeoutMilliseconds?: number;
  readonly operationTimeoutMilliseconds?: number;
}

export class PostgresMessagingRepository
  implements OutboxRepository, ConsumerInbox, ExecutionReadyInspector
{
  readonly #pool: Pool;
  readonly #endpoints: PostgresEndpointPool;

  public constructor(
    connectionString: PostgresConnectionTarget,
    options: PostgresMessagingRepositoryOptions = {},
  ) {
    const connectionTimeoutMilliseconds = positiveInteger(
      options.connectionTimeoutMilliseconds ?? 5_000,
      "connectionTimeoutMilliseconds",
    );
    const operationTimeoutMilliseconds = positiveInteger(
      options.operationTimeoutMilliseconds ?? 30_000,
      "operationTimeoutMilliseconds",
    );
    this.#endpoints = createPostgresEndpointPool(connectionString, {
      connectionTimeoutMillis: connectionTimeoutMilliseconds,
      max: 20,
      query_timeout: operationTimeoutMilliseconds,
      statement_timeout: operationTimeoutMilliseconds,
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

  public async claimBatch(input: {
    readonly leaseMilliseconds: number;
    readonly limit: number;
    readonly now: Date;
    readonly publisherId: string;
  }): Promise<readonly ClaimedOutboxMessage[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new RuntimeError("INVALID_REQUEST", "Outbox claim limit must be between 1 and 500");
    }
    if (!Number.isSafeInteger(input.leaseMilliseconds) || input.leaseMilliseconds < 1) {
      throw new RuntimeError("INVALID_REQUEST", "Outbox lease must be a positive integer");
    }
    const claimToken = `claim_${randomUUID()}`;
    const claimedUntil = new Date(input.now.getTime() + input.leaseMilliseconds);
    const result = await this.#pool.query<OutboxRow>(
      `WITH candidates AS (
         SELECT id
           FROM outbox
          WHERE published_at IS NULL
            AND next_attempt_at <= $1
            AND (claimed_until IS NULL OR claimed_until <= $1)
          ORDER BY next_attempt_at, created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE outbox o
          SET claimed_by = $3,
              claim_token = $4,
              claimed_until = $5,
              attempts = o.attempts + 1,
              last_error = NULL
         FROM candidates c
        WHERE o.id = c.id
      RETURNING o.id, o.aggregate_type, o.aggregate_id, o.event_type, o.payload,
                o.created_at, o.attempts, o.claim_token`,
      [input.now, input.limit, input.publisherId, claimToken, claimedUntil],
    );
    return result.rows.map(mapOutboxRow);
  }

  public async markPublished(input: {
    readonly claimToken: string;
    readonly id: string;
    readonly publishedAt: Date;
    readonly publisherId: string;
  }): Promise<void> {
    await this.#transaction(async (client) => {
      const published = await client.query<{
        aggregate_id: string;
        event_type: string;
        payload: unknown;
      }>(
        `UPDATE outbox
          SET published_at = $4, claimed_by = NULL, claim_token = NULL,
              claimed_until = NULL, last_error = NULL
        WHERE id = $1 AND claimed_by = $2 AND claim_token = $3 AND published_at IS NULL
      RETURNING aggregate_id, event_type, payload`,
        [input.id, input.publisherId, input.claimToken, input.publishedAt],
      );
      const row = published.rows[0];
      if (published.rowCount !== 1 || row === undefined) {
        throw new RuntimeError("DELIVERY_UNKNOWN", "Outbox publish claim is no longer current");
      }
      if (row.event_type !== "ExecutionReady" || !isRecord(row.payload)) return;
      const generation = row.payload.generation;
      const executionId = row.payload.executionId;
      if (
        typeof generation !== "number" ||
        !Number.isSafeInteger(generation) ||
        typeof executionId !== "string"
      ) {
        throw new RuntimeError("DELIVERY_UNKNOWN", "Published Outbox payload is invalid");
      }
      const sequence = await nextEventSequence(client, row.aggregate_id, generation);
      await client.query(
        `INSERT INTO session_events
          (id, session_id, session_generation, event_sequence, event_type,
           execution_id, payload, created_at)
         VALUES ($1, $2, $3, $4, 'outbox.published', $5, $6, $7)`,
        [
          `evt_outbox_${randomUUID()}`,
          row.aggregate_id,
          generation,
          sequence,
          executionId,
          JSON.stringify({ messageId: input.id }),
          input.publishedAt,
        ],
      );
    });
  }

  public async releaseFailed(input: {
    readonly claimToken: string;
    readonly error: string;
    readonly id: string;
    readonly nextAttemptAt: Date;
    readonly publisherId: string;
  }): Promise<void> {
    await expectOne(
      this.#pool,
      `UPDATE outbox
          SET claimed_by = NULL, claim_token = NULL, claimed_until = NULL,
              last_error = $4, next_attempt_at = $5
        WHERE id = $1 AND claimed_by = $2 AND claim_token = $3 AND published_at IS NULL`,
      [
        input.id,
        input.publisherId,
        input.claimToken,
        truncateError(input.error),
        input.nextAttemptAt,
      ],
      "Outbox failure claim is no longer current",
    );
  }

  public async acquire(input: {
    readonly consumerId: string;
    readonly leaseMilliseconds: number;
    readonly messageId: string;
    readonly now: Date;
    readonly payloadHash: string;
  }): Promise<InboxAcquireResult> {
    return this.#transaction(async (client) => {
      const current = await client.query<InboxRow>(
        `SELECT payload_hash, status, attempts, claimed_until
           FROM consumer_inbox
          WHERE consumer_id = $1 AND message_id = $2
          FOR UPDATE`,
        [input.consumerId, input.messageId],
      );
      const row = current.rows[0];
      if (row?.payload_hash !== undefined && row.payload_hash !== input.payloadHash) {
        return { kind: "CONFLICT" };
      }
      if (row?.status === "COMPLETED") return { kind: "COMPLETED" };
      if (
        row?.status === "PROCESSING" &&
        row.claimed_until !== null &&
        row.claimed_until.getTime() > input.now.getTime()
      ) {
        return { kind: "BUSY" };
      }
      const leaseToken = `inbox_${randomUUID()}`;
      const claimedUntil = new Date(input.now.getTime() + input.leaseMilliseconds);
      if (row === undefined) {
        await client.query(
          `INSERT INTO consumer_inbox
            (consumer_id, message_id, payload_hash, status, attempts, lease_token,
             claimed_until, first_received_at, updated_at)
           VALUES ($1, $2, $3, 'PROCESSING', 1, $4, $5, $6, $6)`,
          [
            input.consumerId,
            input.messageId,
            input.payloadHash,
            leaseToken,
            claimedUntil,
            input.now,
          ],
        );
        return { attempt: 1, kind: "ACQUIRED", leaseToken };
      }
      const attempts = row.attempts + 1;
      await client.query(
        `UPDATE consumer_inbox
            SET status = 'PROCESSING', attempts = $3, lease_token = $4,
                claimed_until = $5, updated_at = $6
          WHERE consumer_id = $1 AND message_id = $2`,
        [input.consumerId, input.messageId, attempts, leaseToken, claimedUntil, input.now],
      );
      return { attempt: attempts, kind: "ACQUIRED", leaseToken };
    });
  }

  public async complete(input: {
    readonly completedAt: Date;
    readonly consumerId: string;
    readonly leaseToken: string;
    readonly messageId: string;
    readonly outcome: string;
  }): Promise<void> {
    await expectOne(
      this.#pool,
      `UPDATE consumer_inbox
          SET status = 'COMPLETED', outcome = $4, completed_at = $5,
              claimed_until = NULL, lease_token = NULL, last_error = NULL, updated_at = $5
        WHERE consumer_id = $1 AND message_id = $2 AND lease_token = $3
          AND status = 'PROCESSING'`,
      [input.consumerId, input.messageId, input.leaseToken, input.outcome, input.completedAt],
      "Consumer Inbox lease is no longer current",
    );
  }

  public async release(input: {
    readonly consumerId: string;
    readonly error: string;
    readonly leaseToken: string;
    readonly messageId: string;
  }): Promise<void> {
    await expectOne(
      this.#pool,
      `UPDATE consumer_inbox
          SET status = 'PENDING', claimed_until = NULL, lease_token = NULL,
              last_error = $4, updated_at = now()
        WHERE consumer_id = $1 AND message_id = $2 AND lease_token = $3
          AND status = 'PROCESSING'`,
      [input.consumerId, input.messageId, input.leaseToken, truncateError(input.error)],
      "Consumer Inbox lease is no longer current",
    );
  }

  public async inspectExecutionReady(
    message: ExecutionReadyMessage,
  ): Promise<ExecutionReadyInspection> {
    const result = await this.#pool.query<ExecutionReadyRow>(
      `SELECT e.session_id, e.session_generation, e.status AS execution_status,
              s.current_generation, s.status AS session_status,
              s.active_execution_id, s.owner_id
         FROM executions e
         JOIN sessions s ON s.id = e.session_id
        WHERE e.id = $1`,
      [message.payload.executionId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return { kind: "INVALID", reason: "ExecutionReady references a missing Execution" };
    }
    if (
      row.session_id !== message.aggregate.sessionId ||
      row.session_generation !== message.payload.generation
    ) {
      return { kind: "INVALID", reason: "ExecutionReady identity does not match PostgreSQL" };
    }
    if (
      row.execution_status === "DISPATCHING" &&
      row.current_generation === message.payload.generation &&
      row.session_status === "RESERVED" &&
      row.active_execution_id === message.payload.executionId
    ) {
      return { kind: "READY", ownerId: row.owner_id };
    }
    return {
      kind: "STALE",
      reason: `Execution is ${row.execution_status}; Session is ${row.session_status}`,
    };
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
}

interface OutboxRow {
  readonly aggregate_id: string;
  readonly aggregate_type: string;
  readonly attempts: number;
  readonly claim_token: string;
  readonly created_at: Date;
  readonly event_type: string;
  readonly id: string;
  readonly payload: unknown;
}

interface InboxRow {
  readonly attempts: number;
  readonly claimed_until: Date | null;
  readonly payload_hash: string;
  readonly status: "COMPLETED" | "PENDING" | "PROCESSING";
}

interface ExecutionReadyRow {
  readonly active_execution_id: string | null;
  readonly current_generation: number;
  readonly execution_status: string;
  readonly owner_id: string;
  readonly session_generation: number;
  readonly session_id: string;
  readonly session_status: string;
}

function mapOutboxRow(row: OutboxRow): ClaimedOutboxMessage {
  if (!isRecord(row.payload)) {
    throw new RuntimeError("DELIVERY_UNKNOWN", "Outbox payload is not a JSON object");
  }
  return {
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type,
    attempt: row.attempts,
    claimToken: row.claim_token,
    createdAt: row.created_at.toISOString(),
    eventType: row.event_type,
    id: row.id,
    payload: row.payload,
  };
}

async function expectOne(
  pool: Pool,
  query: string,
  values: readonly unknown[],
  message: string,
): Promise<void> {
  const result = await pool.query(query, [...values]);
  if (result.rowCount !== 1) throw new RuntimeError("DELIVERY_UNKNOWN", message);
}

async function nextEventSequence(
  client: PoolClient,
  sessionId: string,
  generation: number,
): Promise<number> {
  const result = await client.query<{ next_event_sequence: string }>(
    `UPDATE session_generations SET next_event_sequence = next_event_sequence + 1
      WHERE session_id = $1 AND generation = $2
    RETURNING next_event_sequence`,
    [sessionId, generation],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RuntimeError("SESSION_GENERATION_CHANGED", "Outbox Session generation is missing");
  }
  return Number.parseInt(row.next_event_sequence, 10);
}

function truncateError(value: string): string {
  return value.slice(0, 4096);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RuntimeError("INVALID_REQUEST", `${name} must be a positive integer`, {
      [name]: value,
    });
  }
  return value;
}
