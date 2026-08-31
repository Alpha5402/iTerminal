import { operationalErrorMessage } from "@iterminal/observability";
import { configuredPostgresConnectionTarget } from "@iterminal/persistence-postgres";

import { runDurableFactRetentionMaintenance } from "./durable-facts.js";

if (process.argv.includes("--help")) {
  process.stdout.write(`Usage:
  ITERM_DATABASE_URL=postgresql://... pnpm facts:maintain
  ITERM_DATABASE_URLS=postgresql://primary,... pnpm facts:maintain

Applies migrations and deletes at most one configured batch from each eligible normalized-fact class.
The JSON result contains policy and aggregate deletion counts only.
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
  const result = await runDurableFactRetentionMaintenance(databaseTarget);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${operationalErrorMessage(error, "Durable fact maintenance failed")}\n`);
  process.exitCode = 1;
}
