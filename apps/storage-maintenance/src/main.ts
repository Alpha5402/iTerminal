import { configuredPostgresConnectionTarget } from "@iterminal/persistence-postgres";

import { runArtifactStorageMaintenance } from "./maintenance.js";

if (process.argv.includes("--help")) {
  process.stdout.write(`Usage:
  ITERM_DATABASE_URL=postgresql://... pnpm storage:maintain
  ITERM_DATABASE_URLS=postgresql://primary,... pnpm storage:maintain

Applies migrations and deletes at most one configured batch of expired Artifacts.
The JSON result contains policy and usage metadata only, never Artifact content.
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
  const result = await runArtifactStorageMaintenance(databaseTarget);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Artifact storage maintenance failed"}\n`,
  );
  process.exitCode = 1;
}
