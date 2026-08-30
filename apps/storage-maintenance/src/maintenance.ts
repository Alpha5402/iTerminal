import {
  PostgresObservationRepository,
  PostgresRuntimeRepository,
  type ArtifactStorageMaintenanceResult,
  type PostgresConnectionTarget,
} from "@iterminal/persistence-postgres";

export async function runArtifactStorageMaintenance(
  databaseTarget: PostgresConnectionTarget,
): Promise<ArtifactStorageMaintenanceResult> {
  const migrator = new PostgresRuntimeRepository(databaseTarget, { poolMax: 1 });
  const observation = new PostgresObservationRepository(databaseTarget, { poolMax: 1 });
  try {
    await migrator.migrate();
    return await observation.maintainArtifactStorage();
  } finally {
    await Promise.allSettled([observation.close(), migrator.close()]);
  }
}
