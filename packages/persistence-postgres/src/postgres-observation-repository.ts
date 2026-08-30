import { createHash, randomUUID } from "node:crypto";

import type { Actor } from "@iterminal/domain";
import type { SessionFence } from "@iterminal/application";
import { RuntimeError } from "@iterminal/domain";
import { Pool, type PoolClient } from "pg";

import { guardPostgresPool } from "./postgres-pool.js";
import { assertSessionFence, throwSessionLeaseLost } from "./session-fencing.js";

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
  readonly actor?: Readonly<{
    id: string;
    type: string;
    principal: string;
    client: string;
  }>;
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
  principal: string | null;
  client: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

export interface PostgresObservationRepositoryOptions {
  readonly requireSessionFence?: boolean;
}

export class PostgresObservationRepository {
  readonly #pool: Pool;
  readonly #requireSessionFence: boolean;

  public constructor(connectionString: string, options: PostgresObservationRepositoryOptions = {}) {
    this.#requireSessionFence = options.requireSessionFence ?? false;
    this.#pool = guardPostgresPool(
      new Pool({
        connectionString,
        connectionTimeoutMillis: 5_000,
        max: 10,
        query_timeout: 30_000,
        statement_timeout: 30_000,
      }),
    );
  }

  public async close(): Promise<void> {
    await this.#pool.end();
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
    return this.#transaction(async (client) => {
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
      if (input.actor !== undefined) {
        await client.query(
          `INSERT INTO actors (id, actor_type, principal, client)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE
             SET actor_type = EXCLUDED.actor_type,
                 principal = EXCLUDED.principal,
                 client = EXCLUDED.client`,
          [input.actor.id, input.actor.type, input.actor.principal, input.actor.client],
        );
      }
      const content = Buffer.from(input.data, "utf8");
      const tailPreview = content
        .subarray(Math.max(0, content.length - DEFAULT_TAIL_BYTES))
        .toString("utf8");
      const sequence = await allocateEventSequence(client, input.sessionId, input.generation, 1);
      const threshold = input.inlineThresholdBytes ?? DEFAULT_INLINE_BYTES;
      if (!Number.isSafeInteger(threshold) || threshold < 0) {
        throw new RuntimeError(
          "INVALID_REQUEST",
          "Inline threshold must be a non-negative safe integer",
        );
      }
      let artifactRef: string | undefined;
      if (content.length > threshold) {
        artifactRef = `art_${randomUUID()}`;
        await client.query(
          `INSERT INTO artifacts
            (id, session_id, session_generation, execution_id, kind, content,
             content_type, byte_size, sha256, created_at, expires_at)
           VALUES ($1, $2, $3, $4, 'pty_output', $5, 'application/octet-stream',
                   $6, $7, $8::timestamptz, $8::timestamptz + interval '7 days')`,
          [
            artifactRef,
            input.sessionId,
            input.generation,
            input.executionId ?? null,
            content,
            content.length,
            createHash("sha256").update(content).digest("hex"),
            input.createdAt,
          ],
        );
      }
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
        byteCount: content.length,
        eventSequence: sequence,
        tailPreview,
        ...(artifactRef === undefined ? {} : { artifactRef }),
      };
    });
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

function eventSelect(): string {
  return `SELECT e.id, e.session_id, e.session_generation, e.event_sequence,
                 e.event_type, e.action_id, e.execution_id, e.actor_id,
                 e.payload, e.created_at,
                 a.actor_type, a.principal, a.client
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
          actor: {
            client: row.client ?? "unknown",
            id: row.actor_id,
            principal: row.principal ?? "unknown",
            type: row.actor_type ?? "unknown",
          },
        }),
  };
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
