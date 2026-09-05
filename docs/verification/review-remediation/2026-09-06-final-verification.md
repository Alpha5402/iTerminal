# Final remediation integration verification — 2026-09-06

## Revision and isolation

Candidate: all review-remediation integration changes after
`5c59a49ed034bb3d6e59231a4c3e93f20128d4ea` on `codex/remediation-integration`.
The final code/document commit(s) carrying this report identify the delivered candidate.
Only `/private/tmp/iterminal-remediation-integration` was edited. The original user checkout and
its dirty state were preserved. No user terminal/runtime service was restarted or used for tests.

Environment: macOS arm64 / Apple M5, Node v24.15.0, pnpm 10.33.2, real zsh PTY, local Google Chrome,
official MCP stdio client. PostgreSQL was the dedicated `iterminal-d01-postgres`, loopback 55433,
database `iterminal_test`. A temporary helper read this fixture's Docker configuration and injected
its secret only into child environment; no credentials are included in this report or committed.
`ITERM_TEST_POSTGRES_CONTAINER` named this same fixture. Database-mutating/outage suites ran serially.
Use `TMPDIR=/tmp` on macOS to avoid the long default temporary Unix-socket path.

## Current gates

| Command (with isolated DB environment) | Result                                                                   | Scope                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `TMPDIR=/tmp pnpm verify:integration`  | PASS, 10 files / 56 tests / 0 skipped, 01:04, 29.69 s                    | Explicit L1/L2 manifest including 10 F02 workflows                         |
| `TMPDIR=/tmp pnpm verify:shared-path`  | PASS, 2 files / 14 tests / 0 skipped, 01:06, 70.59 s                     | Real Browser + official MCP + PTY + PostgreSQL L3                          |
| `TMPDIR=/tmp pnpm verify`              | PASS, 96 files / 451 passed / 26 optional skipped, 01:16, tests 196.14 s | Format, lint, typecheck, all ordinary tests, historic report checks, build |
| Missing DB negative                    | Expected exit 1, `ITERM_DATABASE_URL is required`                        | No silent skip                                                             |
| Missing Chrome negative                | Expected exit 1, missing `/nonexistent/chrome`                           | No silent browser skip                                                     |

Negative commands: `env -u ITERM_DATABASE_URL node scripts/verify-integration.mjs` and, while retaining
the isolated DB environment, `ITERM_BROWSER_EXECUTABLE=/nonexistent/chrome node scripts/verify-integration.mjs --shared-path`.

Additional current targeted results:

- `apps/runtime-daemon/src/owner-registry.test.ts`: 4/4 passed at 00:56 with short TMPDIR; includes
  direct Session-fence isolation, owner-wide loss and conservative recovery.
- `apps/runtime-router/src/server.test.ts apps/mcp/src/mcp-stdio.test.ts apps/local-stack/src/credential-renewal.test.ts`:
  3 files / 23 passed at 01:08. Includes caller cancellation of pending traversal, fixed tool/capability
  contract, six credential lifecycle/name-validation cases and real MCP client restart.
- The fault subset at 00:58 passed interaction-crash (2), real remote-reclamation (1), real
  postgres-outage (2), history (3) and metadata (2); its MCP file still failed an outdated exact
  capability assertion then, and is superseded by the passing 01:08 MCP result. No failed run is
  counted as a successful gate.
- Earlier card-focused real local-stack/CLI/fencing tests, screen/copy/renderer and Application
  behavior suites are superseded for closure by the current required/ordinary gates.

## Test ownership by card

| Cards   | Primary behavior evidence                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C04/C05 | `packages/terminal-screen/src` including history/copy, `terminal-renderer.test.ts`, `remediation-browser.test.ts`, daemon `terminal-response.test.ts`              |
| D01     | daemon `owner-registry.test.ts`, `postgres-outage.test.ts`, Application `runtime-durability.test.ts`, PostgreSQL Session fencing                                   |
| D02/D07 | router `server.test.ts` / `runtime-router.test.ts`, MCP `router-routing.test.ts`, Application approval/auth matrix, real background inbox and paging browser cases |
| D04/D05 | local-stack real renewals/expiry/restart tests and fake-clock/name-validation cases, existing signed-grant and authorization suites                                |
| D06     | CLI `shared-runtime.test.ts`, daemon durable Runtime, official MCP restart and authorization suites                                                                |
| E01     | `stream-observation.test.ts`, full browser gate and real baseline/current WS benchmark                                                                             |
| E02/E03 | byte-ring reference tests, execution output, control protocol and terminal response, reproducible ring/FIFO/projection benchmark                                   |
| E04/E05 | existing Application wait/admission/interaction/secret/retention tests; full Console directory and real browser regression                                         |
| E06/F02 | Explicit no-skip manifests and all ten official MCP workflow metrics                                                                                               |
| F03/F04 | Static operation-matrix/source reconciliation, Markdown formatting, link/diff checks                                                                               |

## Failed attempts and corrections

The first ordinary full run was **8 failed / 440 passed / 26 skipped**, 106 files, 211.87 seconds.
Failures were retained and addressed before acceptance:

- Two MCP exact-tool assertions and one subsequently exposed exact-capability assertion omitted
  newly added discovery/observation contracts; expected inventories were updated, old tools retained.
- Two crash-recovery assertions expected SESSION_BROKEN for a repeated original key. A04/B06 already
  require returning its durable UNKNOWN fact. Tests now check UNKNOWN/same key and one write attempt,
  preserving the actual crash/no-replay side-effect checks.
- One remote-reclamation Unix socket failed `listen EINVAL` under macOS's long default TMPDIR;
  short `/tmp` fixed it and the real reclamation scenario passed.
- Two Session-fence cases reported unavailable in that run; both passed individually with short
  TMPDIR. The final full run, not the isolated pass alone, is required for closure.
- A browser test waited only for generic RUNNING, which could refer to the preceding Execution;
  it now waits for the exact Python Execution shown by the mode bar.

The next full run had **2 failed / 449 passed / 26 skipped**, 197.65 seconds. Both failures
were Session creation BACKPRESSURE with maxRequests=1. The owner-registry capacity test changed
`session_creation_policies`, a singleton table outside `TRUNCATE sessions CASCADE`, and only reset
it before its own next test. Its afterEach now restores the fixture policy as well, preventing
order-dependent leakage into MCP routing and PostgreSQL fencing tests. This changes test isolation,
not runtime capacity semantics.

Earlier shared-path attempts also exposed bootstrap-before-cookie requests, a side-panel composer
geometry race, xterm callback-before-DOM-paint assertion timing, one nonreproducing offline timeout,
and a real submission-result overlay blocking the sensitive-input control. The current code waits
for bootstrap, performs layout coordination, keeps visual assertions on actual DOM state and places
submission notices in normal toolbar layout. All 14 current real shared-path scenarios pass.

The initial structuredClone frame cache was slower than uncached cells; it was replaced with
independent narrow copies and remeasured. The first WS benchmark delta ACK was malformed in the
fixture; those incomplete-receipt measurements were discarded. Qualified performance reports
include the increased styled payload bytes and remaining high-throughput latency.

The final complete run passed format, lint, typecheck, **451 tests / 26 optional skips**,
53 historical report checks and the build. The capacity producer (9 tests) followed immediately
by the previously affected consumers (3 tests) also passed. The final diff has no blocking review
finding; all 45 RPC operations are present in the F03 matrix and all newly linked report paths
resolve. Staging excludes artifacts, logs, recordings, databases, credentials and caches.

## Review and delivery boundaries

No new Session ACL was implemented: F03 is L0 design. Shared-local actor/grant semantics remain.
Application owns all transitions and exact generation/fence checks; adapter changes do not own
mutation state. New RPC reads have schemas and operation grants, and legacy list/screen tools remain.
Read cancellation is propagated through the inbox transport/router; it never replays accepted work.

Per-card reports are `2026-09-06-C04.md` through the named remaining D/E/F cards; historical 19-card
reports remain unchanged. [Final reconciliation](../../plans/review-remediation/final-reconciliation.md)
links all 28 findings and 36 cards. The raw performance JSON/screenshots are ignored local artifacts;
commands and qualified numerical results are tracked in E01/E02/E03/F02 reports.

## Not proven

L3 applies only to these real local Browser/MCP flows. D01 and E01/E03 cover specifically named local
failure/pressure cases, not complete L4. RabbitMQ/quorum/network/cross-platform/dogfood conditions
not run in the ordinary gate remain unproven. The build reports a roughly 593 kB minified Console
chunk warning. Compact MCP output and styled WS frames do not universally reduce bytes. No paid
model usage, production uptime, cross-host fencing, arbitrary TUI compatibility or Session tenancy
is claimed. The user's already-running services are still the user's existing processes; pushing
source does not hot-reload them.
