import { readFile } from "node:fs/promises";

import type { Pool } from "pg";

const migrations = [
  "001_initial.sql",
  "002_bounded_observation.sql",
  "003_reliable_messaging.sql",
  "004_interaction_guards.sql",
  "005_terminal_geometry.sql",
] as const;

export async function migrateDatabase(pool: Pool): Promise<void> {
  for (const migration of migrations) {
    const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
    await pool.query(sql);
  }
}
