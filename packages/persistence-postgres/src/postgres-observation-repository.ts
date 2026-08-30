import { createHash, randomUUID } from "node:crypto";

import type { Actor } from "@iterminal/domain";
import type { SessionFence } from "@iterminal/application";
import { RuntimeError } from "@iterminal/domain";
import type { Pool, PoolClient } from "pg";

import { createPostgresEndpointPool, type PostgresConnectionTarget } from "./postgres-endpoints.js";
import { assertSessionFence, throwSessionLeaseLost } from "./session-fencing.js";
import { actorFromRow, persistActor } from "./actors.js";

const MAX_EVENT_LIMIT = 500;
const MAX_SEARCH_LIMIT = 50;
const MAX_ARTIFACT_READ_BYTES = 64 * 1024;
const DEFAULT_INLINE_BYTES = 4 * 1024;
const DEFAULT_TAIL_BYTES = 2 * 1024;

export interface EventObservation {
  readonly id: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly type: string;
  readonly actionId?: string;
  readonly executionId?: string;
  readonly actor?: Actor;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface EventQuery {
  readonly sessionId: string;
  readonly generation: number;
  readonly after?: number;
  readonly before?: number;
  readonly from?: Date;
  readonly to?: Date;
  readonly executionId?: string;
  readonly types?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface EventQueryPage {
  readonly events: readonly EventObservation[];
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface SearchMatch {
  readonly event: EventObservation;
  readonly context: readonly EventObservation[];
}

export interface ArtifactWriteResult {
  readonly eventSequence: number;
  readonly byteCount: number;
  readonly tailPreview: string;
  readonly artifactRef?: string;
}

export interface ArtifactStoragePolicy {
  readonly cleanupBatchSize: number;
  readonly maxArtifactBytes: number;
  readonly maxBytes: number;
  readonly retentionMilliseconds: number;
  readonly updatedAt: string;
}

export interface ArtifactStorageUsage {
  readonly artifactCount: number;
  readonly byteSize: number;
  readonly updatedAt: string;
}

export interface ArtifactStorageState {
  readonly policy: ArtifactStoragePolicy;
  readonly usage: ArtifactStorageUsage;
}

export interface ArtifactStorageMaintenanceResult extends ArtifactStorageState {
  readonly before: ArtifactStorageUsage;
  readonly deletedArtifacts: number;
  readonly deletedBytes: number;
}

interface CursorPayload {
  readonly version: 1;
  readonly sessionId: string;
  readonly generation: number;
  readonly after: number;
  readonly fingerprint: string;
}

interface EventRow {
  id: string;
  session_id: string;
  session_generation: number;
  event_sequence: string;
  event_type: string;
  action_id: string | null;
  execution_id: string | null;
  actor_id: string | null;
  actor_type: string | null;
  capabilities: string[] | null;
  principal: string | null;
  client: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

interface ArtifactStorageStateRow {
  artifact_count: string;
  cleanup_batch_size: number;
  max_artifact_bytes: string;
  max_bytes: string;
  policy_updated_at: Date;
  retention_milliseconds: string;
  usage_byte_size: string;
  usage_updated_at: Date;
}

interface ArtifactAdmissionRejection {
  readonly currentBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxBytes: number;
  readonly reason: "aggregate_budget" | "artifact_too_large";
  readonly requestedBytes: number;
}

export interface PostgresObservationRepositoryOptions {
  readonly idleTransactionTimeoutMilliseconds?: number;
  readonly poolMax?: number;
  readonly requireSessionFence?: boolean;
}

export class PostgresObservationRepository {
  readonly #pool: Pool;
  readonly #requireSessionFence: boolean;

  public constructor(
    connectionString: PostgresConnectionTarget,
    options: PostgresObservationRepositoryOptions = {},
  ) {
    this.#requireSessionFence = options.requireSessionFence ?? false;
    const idleTransactionTimeoutMilliseconds = positiveInteger(
      options.idleTransactionTimeoutMilliseconds ?? 30_000,
      "idleTransactionTimeoutMilliseconds",
    );
    const poolMax = positiveInteger(options.poolMax ?? 10, "poolMax");
    this.#pool = createPostgresEndpointPool(connectionString, {
      connectionTimeoutMillis: 5_000,
      idle_in_transaction_session_timeout: idleTransactionTimeoutMilliseconds,
      max: poolMax,
      query_timeout: 30_000,
      statement_timeout: 30_000,
    }).pool;
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }

  public async healthCheck(): Promise<void> {
    await this.#pool.query("SELECT 1");
  }

  public async inspectArtifactStorage(): Promise<ArtifactStorageState> {
    return mapArtifactStorageState(await artifactStorageState(this.#pool));
  }

  public async maintainArtifactStorage(now?: Date): Promise<ArtifactStorageMaintenanceResult> {
    if (now !== undefined && Number.isNaN(now.getTime())) {
      throw new RuntimeError("INVALID_REQUEST", "Artifact maintenance time must be valid");
    }
    return this.#transaction(async (client) => {
      const beforeRow = await artifactStorageState(client);
      const deleted = await deleteExpiredArtifacts(client, now, beforeRow.cleanup_batch_size);
      const after = mapArtifactStorageState(await artifactStorageState(client, true));
      return {
        ...after,
        before: mapArtifactStorageState(beforeRow).usage,
        deletedArtifacts: deleted.count,
        deletedBytes: deleted.bytes,
      };
    });
  }

  public async getEvent(eventId: string): Promise<EventObservation | undefined> {
    const result = await this.#pool.query<EventRow>(`${eventSelect()} WHERE e.id = $1`, [eventId]);
    return result.rows[0] === undefined ? undefined : mapEvent(result.rows[0]);
  }

  public async getExecution(
    executionId: string,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    const result = await this.#pool.query<{
      id: string;
      action_id: string;
      session_id: string;
      session_generation: number;
      status: string;
      exit_code: number | null;
      cwd: string | null;
      started_at: Date | null;
      finished_at: Date | null;
      event_first: string | null;
      event_last: string | null;
      output_bytes: string;
    }>(
      `SELECT x.id, x.action_id, x.session_id, x.session_generation, x.status,
              x.exit_code, x.cwd, x.started_at, x.finished_at,
              min(e.event_sequence) AS event_first,
              max(e.event_sequence) AS event_last,
              coalesce(sum((e.payload->>'byteCount')::bigint)
                FILTER (WHERE e.event_type = 'terminal.pty_output'), 0) AS output_bytes
         FROM executions x
         LEFT JOIN session_events e ON e.execution_id = x.id
        WHERE x.id = $1
        GROUP BY x.id`,
      [executionId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      actionId: row.action_id,
      cwd: row.cwd,
      eventRange:
        row.event_first === null
          ? undefined
          : {
              first: Number.parseInt(row.event_first, 10),
              last: Number.parseInt(row.event_last ?? row.event_first, 10),
            },
      executionId: row.id,
      exitCode: row.exit_code,
      finishedAt: row.finished_at?.toISOString(),
      generation: row.session_generation,
      outputByteCount: Number.parseInt(row.output_bytes, 10),
      sessionId: row.session_id,
      startedAt: row.started_at?.toISOString(),
      status: row.status,
    };
  }

  public async queryEvents(query: EventQuery): Promise<EventQueryPage> {
    const fingerprint = queryFingerprint(query);
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (
      cursor !== undefined &&
      (cursor.sessionId !== query.sessionId ||
        cursor.generation !== query.generation ||
        cursor.fingerprint !== fingerprint)
    ) {
      throw new RuntimeError("RESYNC_REQUIRED", "Cursor scope or query changed", {
        cursorGeneration: cursor.generation,
        requestedGeneration: query.generation,
      });
    }
    const after = cursor?.after ?? query.after ?? 0;
    await this.#assertCursorAvailable(query.sessionId, query.generation, after);
    const limit = bounded(query.limit ?? 100, MAX_EVENT_LIMIT);
    const values: unknown[] = [query.sessionId, query.generation, after];
    const filters = ["e.session_id = $1", "e.session_generation = $2", "e.event_sequence > $3"];
    if (query.before !== undefined) {
      values.push(query.before);
      filters.push(`e.event_sequence < $${values.length.toString()}`);
    }
    if (query.from !== undefined) {
      values.push(query.from);
      filters.push(`e.created_at >= $${values.length.toString()}`);
    }
    if (query.to !== undefined) {
      values.push(query.to);
      filters.push(`e.created_at <= $${values.length.toString()}`);
    }
    if (query.executionId !== undefined) {
      values.push(query.executionId);
      filters.push(`e.execution_id = $${values.length.toString()}`);
    }
    if (query.types !== undefined && query.types.length > 0) {
      values.push(query.types);
      filters.push(`e.event_type = ANY($${values.length.toString()}::text[])`);
    }
    values.push(limit + 1);
    const result = await this.#pool.query<EventRow>(
      `${eventSelect()} WHERE ${filters.join(" AND ")}
       ORDER BY e.event_sequence ASC LIMIT $${values.length.toString()}`,
      values,
    );
    const truncated = result.rows.length > limit;
    const rows = truncated ? result.rows.slice(0, limit) : result.rows;
    const events = rows.map(mapEvent);
    const last = events.at(-1);
    return {
      events,
      truncated,
      ...(truncated && last !== undefined
        ? {
            nextCursor: encodeCursor({
              after: last.sequence,
              fingerprint,
              generation: query.generation,
              sessionId: query.sessionId,
              version: 1,
            }),
          }
        : {}),
    };
  }

  public async searchEvents(input: {
    readonly sessionId: string;
    readonly generation: number;
    readonly keyword: string;
    readonly limit?: number;
    readonly contextBefore?: number;
    readonly contextAfter?: number;
  }): Promise<readonly SearchMatch[]> {
    if (input.keyword.trim().length === 0) {
      throw new RuntimeError("INVALID_REQUEST", "Search keyword must not be empty");
    }
    const limit = bounded(input.limit ?? 20, MAX_SEARCH_LIMIT);
    const matches = await this.#pool.query<EventRow>(
      `${eventSelect()}
       WHERE e.session_id = $1 AND e.session_generation = $2
         AND to_tsvector('simple', e.search_text) @@ plainto_tsquery('simple', $3)
       ORDER BY e.event_sequence ASC LIMIT $4`,
      [input.sessionId, input.generation, input.keyword, limit],
    );
    const before = bounded(input.contextBefore ?? 2, 10);
    const after = bounded(input.contextAfter ?? 2, 10);
    const results: SearchMatch[] = [];
    for (const match of matches.rows) {
      const sequence = Number.parseInt(match.event_sequence, 10);
      const context = await this.#pool.query<EventRow>(
        `${eventSelect()}
         WHERE e.session_id = $1 AND e.session_generation = $2
           AND e.event_sequence BETWEEN $3 AND $4
         ORDER BY e.event_sequence ASC LIMIT 21`,
        [input.sessionId, input.generation, Math.max(1, sequence - before), sequence + after],
      );
      results.push({ context: context.rows.map(mapEvent), event: mapEvent(match) });
    }
    return results;
  }

  public async appendOutput(input: {
    readonly fence?: SessionFence;
    readonly actionId?: string;
    readonly actor?: Actor;
    readonly eventId?: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly executionId?: string;
    readonly data: string;
    readonly createdAt: Date;
    readonly inlineThresholdBytes?: number;
    readonly payload?: Readonly<Record<string, unknown>>;
  }): Promise<ArtifactWriteResult> {
    const threshold = input.inlineThresholdBytes ?? DEFAULT_INLINE_BYTES;
    if (!Number.isSafeInteger(threshold) || threshold < 0) {
      throw new RuntimeError(
        "INVALID_REQUEST",
        "Inline threshold must be a non-negative safe integer",
      );
    }
    const content = Buffer.from(input.data, "utf8");
    const tailPreview = content
      .subarray(Math.max(0, content.length - DEFAULT_TAIL_BYTES))
      .toString("utf8");
    const outcome = await this.#transaction<
      | Readonly<{ readonly kind: "accepted"; readonly result: ArtifactWriteResult }>
      | Readonly<{ readonly kind: "rejected"; readonly rejection: ArtifactAdmissionRejection }>
    >(async (client) => {
      if (input.fence === undefined) {
        if (this.#requireSessionFence) {
          throw new RuntimeError(
            "SESSION_LEASE_LOST",
            "A live Session fence is required for terminal output persistence",
            { generation: input.generation, sessionId: input.sessionId },
            false,
          );
        }
      } else {
        if (
          input.fence.sessionId !== input.sessionId ||
          input.fence.generation !== input.generation
        ) {
          throwSessionLeaseLost(input.fence);
        }
        await assertSessionFence(client, input.fence);
      }
      let artifactRef: string | undefined;
      if (content.length > threshold) {
        const beforeCleanup = await artifactStorageState(client);
        await deleteExpiredArtifacts(client, undefined, beforeCleanup.cleanup_batch_size);
        const storage = await artifactStorageState(client, true);
        const currentBytes = safeNonnegativeInteger(
          storage.usage_byte_size,
          "artifact storage byte size",
        );
        const maxArtifactBytes = positiveIntegerString(
          storage.max_artifact_bytes,
          "Artifact maxArtifactBytes",
        );
        const maxBytes = positiveIntegerString(storage.max_bytes, "Artifact maxBytes");
        const rejection: ArtifactAdmissionRejection | undefined =
          content.length > maxArtifactBytes
            ? {
                currentBytes,
                maxArtifactBytes,
                maxBytes,
                reason: "artifact_too_large",
                requestedBytes: content.length,
              }
            : currentBytes > maxBytes - content.length
              ? {
                  currentBytes,
                  maxArtifactBytes,
                  maxBytes,
                  reason: "aggregate_budget",
                  requestedBytes: content.length,
                }
              : undefined;
        if (rejection !== undefined) return { kind: "rejected", rejection };
        artifactRef = `art_${randomUUID()}`;
        await client.query(
          `INSERT INTO artifacts
            (id, session_id, session_generation, execution_id, kind, content,
             content_type, byte_size, sha256, created_at, expires_at)
           VALUES ($1, $2, $3, $4, 'pty_output', $5, 'application/octet-stream',
                   $6, $7, $8::timestamptz,
                   now() + $9::bigint * interval '1 millisecond')`,
          [
            artifactRef,
            input.sessionId,
            input.generation,
            input.executionId ?? null,
            content,
            content.length,
            createHash("sha256").update(content).digest("hex"),
            input.createdAt,
            storage.retention_milliseconds,
          ],
        );
      }
      if (input.actor !== undefined) {
        await persistActor(client, input.actor);
      }
      const sequence = await allocateEventSequence(client, input.sessionId, input.generation, 1);
      const payload = {
        ...(input.payload ?? {}),
        byteCount: content.length,
        tailPreview,
        ...(artifactRef === undefined ? { data: input.data } : { artifactRef }),
      };
      await client.query(
        `INSERT INTO session_events
          (id, session_id, session_generation, event_sequence, event_type,
           action_id, execution_id, actor_id, payload, created_at, search_text)
         VALUES ($1, $2, $3, $4, 'terminal.pty_output', $5, $6, $7, $8, $9, $10)`,
        [
          input.eventId ?? `evt_${randomUUID()}`,
          input.sessionId,
          input.generation,
          sequence,
          input.actionId ?? null,
          input.executionId ?? null,
          input.actor?.id ?? null,
          JSON.stringify(payload),
          input.createdAt,
          input.data,
        ],
      );
      return {
        kind: "accepted",
        result: {
          byteCount: content.length,
          eventSequence: sequence,
          tailPreview,
          ...(artifactRef === undefined ? {} : { artifactRef }),
        },
      };
    });
    if (outcome.kind === "rejected") throw artifactStorageBackpressure(outcome.rejection);
    return outcome.result;
  }

  public async readArtifact(
    artifactId: string,
    offset = 0,
    requestedLimit = MAX_ARTIFACT_READ_BYTES,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RuntimeError(
        "INVALID_REQUEST",
        "Artifact offset must be a non-negative safe integer",
      );
    }
    const limit = bounded(requestedLimit, MAX_ARTIFACT_READ_BYTES);
    const result = await this.#pool.query<{
      byte_size: string;
      sha256: string;
      content_type: string;
      chunk: Buffer;
    }>(
      `SELECT byte_size, sha256, content_type,
              substring(content FROM $2 + 1 FOR $3) AS chunk
         FROM artifacts WHERE id = $1 AND expires_at > now()`,
      [artifactId, offset, limit],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    const byteSize = Number.parseInt(row.byte_size, 10);
    const nextOffset = offset + row.chunk.length;
    return {
      artifactId,
      byteSize,
      contentBase64: row.chunk.toString("base64"),
      contentType: row.content_type,
      offset,
      sha256: row.sha256,
      truncated: nextOffset < byteSize,
      ...(nextOffset < byteSize ? { nextOffset } : {}),
    };
  }

  async #assertCursorAvailable(
    sessionId: string,
    generation: number,
    after: number,
  ): Promise<void> {
    if (after === 0) {
      return;
    }
    const result = await this.#pool.query<{ minimum: string | null }>(
      `SELECT min(event_sequence) AS minimum FROM session_events
        WHERE session_id = $1 AND session_generation = $2`,
      [sessionId, generation],
    );
    const minimum = result.rows[0]?.minimum;
    if (minimum !== null && minimum !== undefined && after < Number.parseInt(minimum, 10) - 1) {
      throw new RuntimeError("RESYNC_REQUIRED", "Cursor points before retained event history", {
        minimumAvailableSequence: Number.parseInt(minimum, 10),
      });
    }
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

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeError("INVALID_REQUEST", `${name} must be a positive integer`, {
      [name]: value,
    });
  }
  return value;
}

async function artifactStorageState(
  database: Pick<PoolClient, "query">,
  lock = false,
): Promise<ArtifactStorageStateRow> {
  if (lock) {
    await database.query(
      "SELECT scope FROM artifact_storage_policies WHERE scope = 'default' FOR UPDATE",
    );
    await database.query(
      "SELECT scope FROM artifact_storage_usage WHERE scope = 'default' FOR UPDATE",
    );
  }
  const result = await database.query<ArtifactStorageStateRow>(
    `SELECT policy.max_bytes::text, policy.max_artifact_bytes::text,
            policy.retention_milliseconds::text, policy.cleanup_batch_size,
            policy.updated_at AS policy_updated_at,
            usage.artifact_count::text, usage.byte_size::text AS usage_byte_size,
            usage.updated_at AS usage_updated_at
      FROM artifact_storage_policies policy
      JOIN artifact_storage_usage usage USING (scope)
      WHERE policy.scope = 'default'`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RuntimeError("RUNTIME_UNAVAILABLE", "Artifact storage policy is unavailable", {
      component: "artifact_storage",
    });
  }
  return row;
}

function mapArtifactStorageState(row: ArtifactStorageStateRow): ArtifactStorageState {
  return {
    policy: {
      cleanupBatchSize: positiveInteger(row.cleanup_batch_size, "Artifact cleanupBatchSize"),
      maxArtifactBytes: positiveIntegerString(row.max_artifact_bytes, "Artifact maxArtifactBytes"),
      maxBytes: positiveIntegerString(row.max_bytes, "Artifact maxBytes"),
      retentionMilliseconds: positiveIntegerString(
        row.retention_milliseconds,
        "Artifact retentionMilliseconds",
      ),
      updatedAt: row.policy_updated_at.toISOString(),
    },
    usage: {
      artifactCount: safeNonnegativeInteger(row.artifact_count, "Artifact count"),
      byteSize: safeNonnegativeInteger(row.usage_byte_size, "Artifact byte size"),
      updatedAt: row.usage_updated_at.toISOString(),
    },
  };
}

async function deleteExpiredArtifacts(
  client: PoolClient,
  now: Date | undefined,
  limit: number,
): Promise<Readonly<{ readonly bytes: number; readonly count: number }>> {
  const result = await client.query<{ byte_size: string }>(
    `WITH candidates AS (
       SELECT id
         FROM artifacts
        WHERE expires_at <= coalesce($1::timestamptz, now())
        ORDER BY expires_at ASC, id ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM artifacts artifact
      USING candidates
      WHERE artifact.id = candidates.id
     RETURNING artifact.byte_size::text`,
    [now ?? null, limit],
  );
  return {
    bytes: result.rows.reduce(
      (total, row) => total + safeNonnegativeInteger(row.byte_size, "Deleted Artifact byte size"),
      0,
    ),
    count: result.rowCount ?? 0,
  };
}

function artifactStorageBackpressure(rejection: ArtifactAdmissionRejection): RuntimeError {
  return new RuntimeError(
    "BACKPRESSURE",
    rejection.reason === "artifact_too_large"
      ? "Artifact exceeds the configured per-row storage limit"
      : "Artifact storage budget is exhausted",
    {
      component: "artifact_storage",
      currentBytes: rejection.currentBytes,
      maxArtifactBytes: rejection.maxArtifactBytes,
      maxBytes: rejection.maxBytes,
      phase: "artifact_admission",
      requestedBytes: rejection.requestedBytes,
    },
    true,
  );
}

function positiveIntegerString(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RuntimeError("RUNTIME_UNAVAILABLE", `${name} is invalid`, { [name]: value });
  }
  return parsed;
}

function safeNonnegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RuntimeError("RUNTIME_UNAVAILABLE", `${name} is invalid`, { [name]: value });
  }
  return parsed;
}

function eventSelect(): string {
  return `SELECT e.id, e.session_id, e.session_generation, e.event_sequence,
                 e.event_type, e.action_id, e.execution_id, e.actor_id,
                 e.payload, e.created_at,
                 a.actor_type, a.principal, a.client, a.capabilities
            FROM session_events e
            LEFT JOIN actors a ON a.id = e.actor_id`;
}

function mapEvent(row: EventRow): EventObservation {
  return {
    createdAt: row.created_at.toISOString(),
    generation: row.session_generation,
    id: row.id,
    payload: row.payload,
    sequence: Number.parseInt(row.event_sequence, 10),
    sessionId: row.session_id,
    type: row.event_type,
    ...(row.action_id === null ? {} : { actionId: row.action_id }),
    ...(row.execution_id === null ? {} : { executionId: row.execution_id }),
    ...(row.actor_id === null
      ? {}
      : {
          actor: eventActor(row),
        }),
  };
}

function eventActor(row: EventRow): Actor {
  if (
    row.actor_id === null ||
    row.actor_type === null ||
    row.principal === null ||
    row.client === null ||
    row.capabilities === null
  ) {
    throw new RuntimeError("RUNTIME_UNAVAILABLE", "Durable Event Actor is incomplete", {
      eventId: row.id,
    });
  }
  return actorFromRow({
    actor_id: row.actor_id,
    actor_type: row.actor_type,
    capabilities: row.capabilities,
    client: row.client,
    principal: row.principal,
  });
}

async function allocateEventSequence(
  client: PoolClient,
  sessionId: string,
  generation: number,
  count: number,
): Promise<number> {
  const result = await client.query<{ next_event_sequence: string }>(
    `UPDATE session_generations
        SET next_event_sequence = next_event_sequence + $3
      WHERE session_id = $1 AND generation = $2
    RETURNING next_event_sequence`,
    [sessionId, generation, count],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RuntimeError("SESSION_GENERATION_CHANGED", "Session generation not found");
  }
  return Number.parseInt(row.next_event_sequence, 10);
}

function queryFingerprint(query: EventQuery): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        before: query.before,
        executionId: query.executionId,
        from: query.from?.toISOString(),
        to: query.to?.toISOString(),
        types: query.types === undefined ? undefined : [...query.types].sort(),
      }),
    )
    .digest("hex");
}

function encodeCursor(cursor: CursorPayload): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): CursorPayload {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      parsed.version !== 1 ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.generation !== "number" ||
      typeof parsed.after !== "number" ||
      typeof parsed.fingerprint !== "string"
    ) {
      throw new Error("invalid cursor fields");
    }
    return parsed as CursorPayload;
  } catch {
    throw new RuntimeError("RESYNC_REQUIRED", "Cursor is malformed");
  }
}

function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeError("INVALID_REQUEST", "Limit must be a positive safe integer");
  }
  return Math.min(value, maximum);
}
