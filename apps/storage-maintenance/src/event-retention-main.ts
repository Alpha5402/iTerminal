import { configuredPostgresConnectionTarget } from "@iterminal/persistence-postgres";

import { runEventRetentionMaintenance } from "./event-retention.js";

if (process.argv.includes("--help")) {
  process.stdout.write(`Usage:
  ITERM_DATABASE_URL=postgresql://... pnpm retention:maintain
  ITERM_DATABASE_URLS=postgresql://primary,... pnpm retention:maintain

Applies migrations and deletes at most one configured Event-retention batch from one generation.
The JSON result contains policy and aggregate deletion metadata only.
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
  const result = await runEventRetentionMaintenance(databaseTarget);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Event retention maintenance failed"}\n`,
  );
  process.exitCode = 1;
}
