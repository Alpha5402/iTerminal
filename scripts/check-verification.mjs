import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

const requiredReports = [
  "docs/verification/M0/2026-08-30-shell-integration.md",
  "docs/verification/M1/2026-08-30-runtime-cli.md",
  "docs/verification/M2/2026-08-30-postgres-persistence.md",
  "docs/verification/M3/2026-08-30-bounded-observation.md",
  "docs/verification/M4/2026-08-30-mcp-adapter.md",
  "docs/verification/M4/2026-08-30-durable-runtime.md",
  "docs/verification/M6/2026-08-30-live-virtual-screen.md",
  "docs/verification/M6/2026-08-30-reactive-screen-observation.md",
  "docs/verification/M6/2026-08-30-bounded-screen-sync.md",
  "docs/verification/M6/2026-08-30-styled-screen-cells.md",
  "docs/verification/M6/2026-08-30-interaction-guard.md",
  "docs/verification/M8/2026-08-30-reliable-messaging.md",
  "docs/verification/M8/2026-08-30-owner-dispatch.md",
  "docs/verification/M8/2026-08-30-interaction-crash-retry-outage.md",
  "docs/verification/M8/2026-08-30-admission-backpressure.md",
  "docs/verification/M8/2026-08-30-rabbitmq-process-reconnect.md",
  "docs/verification/M8/2026-08-30-postgres-process-recovery.md",
  "docs/verification/M8/2026-08-30-postgres-loop-recovery.md",
  "docs/verification/M8/2026-08-30-network-blackhole-recovery.md",
  "docs/verification/M8/2026-08-30-rabbitmq-quorum-failover.md",
];

for (const report of requiredReports) {
  const contents = await readFile(new URL(`../${report}`, import.meta.url), "utf8");
  if (!contents.includes("**Result: PASS at L2")) {
    throw new Error(`${report} must contain an explicit L2 PASS claim`);
  }
  if (!contents.includes("## Not proven")) {
    throw new Error(`${report} must retain a Not proven boundary`);
  }
}

process.stdout.write(`Verified ${requiredReports.length.toString()} milestone reports\n`);
