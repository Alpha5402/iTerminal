import {
  PostgresObservationRepository,
  PostgresRuntimeRepository,
  type EventRetentionMaintenanceResult,
  type PostgresConnectionTarget,
} from "@iterminal/persistence-postgres";

export async function runEventRetentionMaintenance(
  databaseTarget: PostgresConnectionTarget,
): Promise<EventRetentionMaintenanceResult> {
  const migrator = new PostgresRuntimeRepository(databaseTarget, { poolMax: 1 });
  const observation = new PostgresObservationRepository(databaseTarget, { poolMax: 1 });
  try {
    await migrator.migrate();
    return await observation.maintainEventRetention();
  } finally {
    await Promise.allSettled([observation.close(), migrator.close()]);
  }
}
