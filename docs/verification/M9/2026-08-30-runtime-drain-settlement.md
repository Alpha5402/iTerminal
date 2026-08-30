# M9.12 bounded Runtime drain settlement verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 16, independent Router and Runtime processes, Unix RPC, and real node-pty/zsh execution).** A root-Session placement committed before the selected owner enters `DRAINING` settles on that exact owner before graceful shutdown. New placement excludes the draining owner, accepted RPC responses drain within the same bounded deadline, and shutdown then closes the Session and persists `STOPPED`.

## Environment and commands

- Disposable PostgreSQL 16 Alpine `iterminal_test` on `127.0.0.1:55432`.
- One production delayed-forward Router fixture and two production Runtime processes with real zsh PTYs.
- Runtime drain deadline: 5 seconds.

```bash
pnpm format
pnpm typecheck

pnpm exec vitest run packages/runtime-rpc/src/index.test.ts

ITERM_DATABASE_URL=postgresql://iterminal:iterminal@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    apps/runtime-router/src/process-chaos.test.ts

pnpm verify
git diff --check
```

- Runtime RPC regression: 1 file / 7 tests passed.
- Independent-process M9 chaos regression: 1 file / 8 scenarios passed.
- Full repository quality gate: 21 files / 85 tests passed; 25 files / 75 tests skipped by explicit environment gates.
- Verification-document audit: 37 milestone reports passed.
- Production build passed; Vite retained the existing non-blocking 543.01 kB Console chunk warning.

## Proven scenarios

| Boundary                   | Result                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| Pre-drain placement        | Router commits owner A placement, pauses before forwarding, and PostgreSQL retains one unfinished intent |
| Drain serialization        | Owner A enters durable `DRAINING`; later placement cannot select it                                      |
| Pending-intent observation | Owner A reports `DRAINING` with exactly one pending root-create intent and remains alive                 |
| Exact-owner settlement     | Releasing the Router binds and returns one Session on the originally selected owner A                    |
| RPC response drain         | The create response reaches the client before the Unix server completes graceful drain                   |
| Healthy-owner progress     | Owner B concurrently creates a Session and executes `printf m912-drain-healthy` through real zsh         |
| Lifecycle completion       | Owner A reports `SETTLED`, closes its new Session, exits zero, and persists exact incarnation `STOPPED`  |
| Durable consistency        | The request binds the returned Session ID; no unfinished intent remains for owner A                      |
| Socket admission boundary  | A focused RPC test proves new sockets stop while an already accepted response completes                  |

## Failures observed during closure

- The first focused Runtime RPC run inside the filesystem sandbox failed five Unix-socket cases with `listen EPERM`; the two pure connection-classification cases still ran. Re-running the same test with the required local socket permission passed all seven tests. This was a sandbox boundary, not a product assertion.
- The first full `pnpm verify` likewise reached the test phase after formatting, lint, and typecheck, then reported 15 Unix/TCP `listen EPERM` failures under the restricted socket sandbox. Re-running the unchanged full command with local socket permission passed all tests, documentation audit, and production build with the counts above.

## Timeout and rollback semantics

- `ITERM_RUNTIME_DRAIN_TIMEOUT_MS` defaults to 5000 and bounds pending-intent settlement plus accepted-response drain under one deadline.
- If the exact-owner pending count or an accepted RPC does not settle before the deadline, shutdown continues and reports `TIMED_OUT`; it does not reassign the intent. A later retry remains governed by exact-owner routing and M9.11 retention.
- Operational rollback may restore immediate RPC close, but only after draining all Runtime owners or accepting that a placement committed before shutdown can remain unfinished until retention. No database migration is introduced by M9.12.

## Not proven

- Deadline expiry under sustained or adversarial load, many concurrent accepted sockets, slow clients, or stuck Router processes.
- Repeated rolling upgrades, process-manager orchestration, remote-host process reclamation, CPU-starved heartbeat, or long soak.
- PostgreSQL minority/quorum, promotion/replication lag, correlated database/broker loss, or cross-region routing.
- M9 L4, M10 security/release gates, or production readiness.
