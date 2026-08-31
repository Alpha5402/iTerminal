import {
  PostgresStorageMaintenanceRepository,
  type DatabaseCapacityState,
  type PostgresConnectionTarget,
} from "@iterminal/persistence-postgres";

export async function runDatabaseCapacityInspection(
  databaseTarget: PostgresConnectionTarget,
): Promise<DatabaseCapacityState> {
  const repository = new PostgresStorageMaintenanceRepository(databaseTarget);
  try {
    await repository.migrate();
    return await repository.inspectDatabaseCapacity();
  } finally {
    await repository.close();
  }
}
