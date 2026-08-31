import { operationalErrorMessage } from "@iterminal/observability";
import { configuredPostgresConnectionTarget } from "@iterminal/persistence-postgres";

import { runDatabaseCapacityInspection } from "./database-capacity.js";

if (process.argv.includes("--help")) {
  process.stdout.write(`Usage:
  ITERM_DATABASE_URL=postgresql://... pnpm capacity:inspect
  ITERM_DATABASE_URLS=postgresql://primary,... pnpm capacity:inspect

Applies migrations and reports pg_database_size against the configured warning/critical policy.
A CRITICAL sample is printed as JSON and exits with status 2. No data is deleted automatically.
`);
  process.exit(0);
}

try {
  const databaseTarget = configuredPostgresConnectionTarget({
    ...(process.env.ITERM_DATABASE_URL === undefined
      ? {}
      : { url: process.env.ITERM_DATABASE_URL }),
    ...(process.env.ITERM_DATABASE_URLS === undefined
      ? {}
      : { urls: process.env.ITERM_DATABASE_URLS }),
  });
  if (databaseTarget === undefined) {
    throw new Error("ITERM_DATABASE_URL or ITERM_DATABASE_URLS is required");
  }
  const result = await runDatabaseCapacityInspection(databaseTarget);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "CRITICAL") process.exitCode = 2;
} catch (error) {
  process.stderr.write(
    `${operationalErrorMessage(error, "Database capacity inspection failed")}\n`,
  );
  process.exitCode = 1;
}
