import { readFile } from "node:fs/promises";

import type { Pool } from "pg";

const MIGRATION_ADVISORY_LOCK = 1_769_238_388;

const migrations = [
  { file: "001_initial.sql", version: 1 },
  { file: "002_bounded_observation.sql", version: 2 },
  { file: "003_reliable_messaging.sql", version: 3 },
  { file: "004_interaction_guards.sql", version: 4 },
  { file: "005_terminal_geometry.sql", version: 5 },
  { file: "006_session_fork.sql", version: 6 },
  { file: "007_runtime_owner_registry.sql", version: 7 },
  { file: "008_runtime_router_indexes.sql", version: 8 },
  { file: "009_session_fencing.sql", version: 9 },
  { file: "010_fair_placement_rate_limits.sql", version: 10 },
  { file: "011_session_creation_idempotency.sql", version: 11 },
  { file: "012_session_creation_retention.sql", version: 12 },
  { file: "013_runtime_capacity_weight.sql", version: 13 },
  { file: "014_actor_capabilities.sql", version: 14 },
  { file: "015_execute_approvals.sql", version: 15 },
  { file: "016_sensitive_inputs.sql", version: 16 },
  { file: "017_artifact_storage_budget.sql", version: 17 },
  { file: "018_bounded_event_retention.sql", version: 18 },
  { file: "019_normalized_fact_retention.sql", version: 19 },
] as const;

export async function migrateDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK]);
    const table = await client.query<{ schema_migrations: string | null }>(
      "SELECT to_regclass('public.schema_migrations')::text AS schema_migrations",
    );
    const applied = new Set<number>();
    const schemaMigrations = table.rows[0]?.schema_migrations;
    if (schemaMigrations !== undefined && schemaMigrations !== null) {
      const versions = await client.query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      for (const row of versions.rows) applied.add(row.version);
    }
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      const sql = await readFile(
        new URL(`../migrations/${migration.file}`, import.meta.url),
        "utf8",
      );
      await client.query(sql);
      applied.add(migration.version);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK]).catch(() => {
      // Releasing the connection also releases this session-level advisory lock.
    });
    client.release();
  }
}
