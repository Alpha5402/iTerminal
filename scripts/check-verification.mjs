import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

const requiredReports = [
  { level: "L2", path: "docs/verification/M0/2026-08-30-shell-integration.md" },
  { level: "L2", path: "docs/verification/M1/2026-08-30-runtime-cli.md" },
  { level: "L2", path: "docs/verification/M2/2026-08-30-postgres-persistence.md" },
  { level: "L2", path: "docs/verification/M3/2026-08-30-bounded-observation.md" },
  { level: "L2", path: "docs/verification/M4/2026-08-30-mcp-adapter.md" },
  { level: "L2", path: "docs/verification/M4/2026-08-30-durable-runtime.md" },
  { level: "L3", path: "docs/verification/M5/2026-08-30-human-console.md" },
  { level: "L2", path: "docs/verification/M6/2026-08-30-live-virtual-screen.md" },
  { level: "L2", path: "docs/verification/M6/2026-08-30-reactive-screen-observation.md" },
  { level: "L2", path: "docs/verification/M6/2026-08-30-bounded-screen-sync.md" },
  { level: "L2", path: "docs/verification/M6/2026-08-30-styled-screen-cells.md" },
  { level: "L2", path: "docs/verification/M6/2026-08-30-interaction-guard.md" },
  { level: "L3", path: "docs/verification/M6/2026-08-30-controlled-terminal-geometry.md" },
  { level: "L2", path: "docs/verification/M6/2026-08-30-terminal-state-evidence.md" },
  { level: "L2", path: "docs/verification/M7/2026-08-30-checkpoint-fork.md" },
  { level: "L3", path: "docs/verification/M7/2026-08-30-durable-human-rebuild.md" },
  { level: "L2", path: "docs/verification/M8/2026-08-30-reliable-messaging.md" },
  { level: "L2", path: "docs/verification/M8/2026-08-30-owner-dispatch.md" },
  { level: "L2", path: "docs/verification/M8/2026-08-30-interaction-crash-retry-outage.md" },
  { level: "L2", path: "docs/verification/M8/2026-08-30-admission-backpressure.md" },
  { level: "L2", path: "docs/verification/M8/2026-08-30-rabbitmq-process-reconnect.md" },
  { level: "L2", path: "docs/verification/M8/2026-08-30-postgres-process-recovery.md" },
  { level: "L2", path: "docs/verification/M8/2026-08-30-postgres-loop-recovery.md" },
  { level: "L2", path: "docs/verification/M8/2026-08-30-network-blackhole-recovery.md" },
  { level: "L2", path: "docs/verification/M8/2026-08-30-rabbitmq-quorum-failover.md" },
  { level: "L2", path: "docs/verification/M9/2026-08-30-runtime-owner-registry.md" },
  { level: "L2", path: "docs/verification/M9/2026-08-30-central-runtime-router.md" },
  { level: "L2", path: "docs/verification/M9/2026-08-30-session-fencing.md" },
  { level: "L2", path: "docs/verification/M9/2026-08-30-fair-placement-rate-limits.md" },
  { level: "L2", path: "docs/verification/M9/2026-08-30-independent-process-chaos.md" },
];

for (const report of requiredReports) {
  const contents = await readFile(new URL(`../${report.path}`, import.meta.url), "utf8");
  if (!contents.includes(`**Result: PASS at ${report.level}`)) {
    throw new Error(`${report.path} must contain an explicit ${report.level} PASS claim`);
  }
  if (!contents.includes("## Not proven")) {
    throw new Error(`${report.path} must retain a Not proven boundary`);
  }
}

process.stdout.write(`Verified ${requiredReports.length.toString()} milestone reports\n`);
