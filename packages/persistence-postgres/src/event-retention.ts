import { RuntimeError } from "@iterminal/domain";
import type { Pool, PoolClient } from "pg";

export interface EventRetentionPolicy {
  readonly cleanupBatchSize: number;
  readonly maxAgeDays: number;
  readonly maxEventsPerGeneration: number;
  readonly updatedAt: string;
}

export interface EventRetentionMaintenanceResult {
  readonly deletedBytes: number;
  readonly deletedEvents: number;
  readonly policy: EventRetentionPolicy;
}

interface PolicyRow {
  cleanup_batch_size: number;
  cutoff: Date;
  max_age_days: number;
  max_events_per_generation: number;
  updated_at: Date;
}

interface GenerationRow {
  deleted_through_sequence: string;
  generation: number;
  next_event_sequence: string;
  session_id: string;
}

interface EventRow {
  byte_size: string;
  created_at: Date;
  event_sequence: string;
  id: string;
}

export async function maintainEventRetention(
  pool: Pool,
  now?: Date,
): Promise<EventRetentionMaintenanceResult> {
  if (now !== undefined && Number.isNaN(now.getTime())) {
    throw new RuntimeError("INVALID_REQUEST", "Event retention time must be valid");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const policy = await lockPolicy(client, now);
    const generation = await selectGeneration(client, policy);
    if (generation === undefined) {
      await client.query("COMMIT");
      return { deletedBytes: 0, deletedEvents: 0, policy: mapPolicy(policy) };
    }
    const rows = await client.query<EventRow>(
      `SELECT event.id, event.event_sequence::text, event.created_at,
              (octet_length(event.payload::text) + octet_length(event.search_text))::text
                AS byte_size
         FROM session_events event
        WHERE event.session_id = $1 AND event.session_generation = $2
        ORDER BY event.event_sequence ASC
        LIMIT $3
        FOR UPDATE`,
      [generation.session_id, generation.generation, policy.cleanup_batch_size],
    );
    const deletedThrough = nonnegativeInteger(
      generation.deleted_through_sequence,
      "Event retention watermark",
    );
    const nextSequence = nonnegativeInteger(
      generation.next_event_sequence,
      "Generation next event sequence",
    );
    const retainedCount = Math.max(0, nextSequence - deletedThrough);
    const masked = rows.rows.filter(
      (row) => nonnegativeInteger(row.event_sequence, "Event sequence") <= deletedThrough,
    );
    let selected: readonly EventRow[];
    if (masked.length > 0) {
      selected = masked;
    } else {
      const countDeletion = Math.max(0, retainedCount - policy.max_events_per_generation);
      let ageDeletion = 0;
      for (const row of rows.rows) {
        if (row.created_at >= policy.cutoff) break;
        ageDeletion += 1;
      }
      const deleteCount = Math.min(
        rows.rows.length,
        Math.max(0, retainedCount - 1),
        Math.max(countDeletion, ageDeletion),
      );
      selected = rows.rows.slice(0, deleteCount);
    }
    if (selected.length === 0) {
      await client.query("COMMIT");
      return { deletedBytes: 0, deletedEvents: 0, policy: mapPolicy(policy) };
    }
    const deleted = await client.query<{ byte_size: string }>(
      `DELETE FROM session_events
        WHERE id = ANY($1::text[])
      RETURNING (octet_length(payload::text) + octet_length(search_text))::text AS byte_size`,
      [selected.map((row) => row.id)],
    );
    await client.query("COMMIT");
    return {
      deletedBytes: deleted.rows.reduce(
        (total, row) => total + nonnegativeInteger(row.byte_size, "Deleted Event bytes"),
        0,
      ),
      deletedEvents: deleted.rowCount ?? 0,
      policy: mapPolicy(policy),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockPolicy(client: PoolClient, now: Date | undefined): Promise<PolicyRow> {
  const result = await client.query<PolicyRow>(
    `SELECT max_age_days, max_events_per_generation, cleanup_batch_size, updated_at,
            coalesce($1::timestamptz, now()) - make_interval(days => max_age_days) AS cutoff
       FROM retention_policies
      WHERE scope = 'default'
      FOR UPDATE`,
    [now ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RuntimeError("RUNTIME_UNAVAILABLE", "Event retention policy is unavailable", {
      component: "event_retention",
    });
  }
  return row;
}

async function selectGeneration(
  client: PoolClient,
  policy: PolicyRow,
): Promise<GenerationRow | undefined> {
  const result = await client.query<GenerationRow>(
    `SELECT generation.session_id, generation.generation,
            generation.next_event_sequence::text,
            coalesce(watermark.deleted_through_sequence, 0)::text AS deleted_through_sequence
       FROM session_generations generation
       LEFT JOIN event_retention_watermarks watermark
         ON watermark.session_id = generation.session_id
        AND watermark.session_generation = generation.generation
       LEFT JOIN LATERAL (
         SELECT event_sequence, created_at
           FROM session_events event
          WHERE event.session_id = generation.session_id
            AND event.session_generation = generation.generation
            AND event.event_sequence > coalesce(watermark.deleted_through_sequence, 0)
          ORDER BY event.event_sequence ASC
          LIMIT 1
       ) oldest ON true
      WHERE EXISTS (
              SELECT 1 FROM session_events masked
               WHERE masked.session_id = generation.session_id
                 AND masked.session_generation = generation.generation
                 AND masked.event_sequence <= coalesce(watermark.deleted_through_sequence, 0)
            )
         OR generation.next_event_sequence - coalesce(watermark.deleted_through_sequence, 0)
              > $1
         OR oldest.created_at < $2
      ORDER BY oldest.created_at ASC NULLS FIRST,
               generation.session_id ASC, generation.generation ASC
      LIMIT 1
      FOR UPDATE OF generation SKIP LOCKED`,
    [policy.max_events_per_generation, policy.cutoff],
  );
  return result.rows[0];
}

function mapPolicy(row: PolicyRow): EventRetentionPolicy {
  return {
    cleanupBatchSize: positiveInteger(row.cleanup_batch_size, "Event cleanup batch size"),
    maxAgeDays: positiveInteger(row.max_age_days, "Event max age days"),
    maxEventsPerGeneration: positiveInteger(
      row.max_events_per_generation,
      "Event max events per generation",
    ),
    updatedAt: row.updated_at.toISOString(),
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeError("RUNTIME_UNAVAILABLE", `${name} is invalid`, { [name]: value });
  }
  return value;
}

function nonnegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RuntimeError("RUNTIME_UNAVAILABLE", `${name} is invalid`, { [name]: value });
  }
  return parsed;
}
