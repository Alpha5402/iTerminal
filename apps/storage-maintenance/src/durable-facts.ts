import {
  PostgresStorageMaintenanceRepository,
  type DurableFactRetentionMaintenanceResult,
  type PostgresConnectionTarget,
} from "@iterminal/persistence-postgres";

export async function runDurableFactRetentionMaintenance(
  databaseTarget: PostgresConnectionTarget,
): Promise<DurableFactRetentionMaintenanceResult> {
  const repository = new PostgresStorageMaintenanceRepository(databaseTarget);
  try {
    await repository.migrate();
    return await repository.maintainDurableFacts();
  } finally {
    await repository.close();
  }
}
