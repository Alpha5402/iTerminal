# M9.9 Router database-partition isolation verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 16, two independent Router processes, two independent Runtime processes, one Router-only silent TCP blackhole, and real node-pty/zsh execution).** A Router that cannot establish current durable routes fails closed without forwarding or consuming placement, while a healthy Router and both owners continue. Resetting stale TCP streams restores the isolated Router without a process restart.

## Environment and commands

- Disposable PostgreSQL 16 `iterminal_test` on `127.0.0.1:55432`
- Two Runtime processes with direct healthy database paths
- Two Router processes; only one Router reaches PostgreSQL through the test TCP proxy
- Router query deadline: 300 ms; Runtime owner/session leases: 2 s

```bash
pnpm typecheck
pnpm exec vitest run apps/runtime-router/src/server.test.ts

ITERM_DATABASE_URL=postgresql://iterminal:iterminal@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    apps/runtime-router/src/process-chaos.test.ts

pnpm verify
git diff --check
```

- Router error-classification unit regression: 1 file / 3 tests passed.
- Independent-process M9 chaos regression: 1 file / 5 scenarios passed.
- Full repository quality gate: 20 enabled files / 82 tests passed; 25 environment-gated files / 69 tests skipped; 34 milestone reports verified; production build passed.
- The existing non-blocking Console chunk-size warning remains at 543.01 kB.

## Proven scenarios

| Boundary                 | Result                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| Healthy baseline         | Isolated-path Router creates a real READY zsh Session before the fault                     |
| Router-only blackhole    | Only that Router's PostgreSQL bytes are discarded; owners and second Router stay connected |
| Bounded failure          | Exact Session lookup returns retryable `RUNTIME_UNAVAILABLE` within 3 s                    |
| Error classification     | Details identify Router, operation, and `route_resolution` without raw connection text     |
| No stale-route fallback  | Unit seam creates no owner client after route DB failure                                   |
| No creation side effect  | Failed root create leaves zero intent and consumes no placement                            |
| Healthy Router progress  | Existing Session executes real zsh and a new Session is created during the partition       |
| Isolated Router liveness | Router process remains alive while its database path is blackholed                         |
| In-process recovery      | `CUT` resets stale streams; `FORWARD` lets the same Router serve the original Session      |
| Exact-key recovery       | Failed create key later yields one intent, one Session, and one additional placement       |
| Recovered live PTY       | Recovered Router routes a real zsh execution to `COMPLETED`                                |

## Not proven

- PostgreSQL minority/quorum behavior, multiple database endpoints, split-brain, synchronous replication, or failover promotion.
- Router cold start while PostgreSQL is unavailable, repeated flapping, circuit-breaker shedding, database saturation, or CPU starvation.
- Correlated Router/owner/RabbitMQ partition, packet delay/reordering/duplication, DNS/TLS/NAT failure, or remote process reclamation.
- Sustained rolling drain, hostile-key cardinality/retention, long soak, M9 L4 Exit Gate, or release readiness.
