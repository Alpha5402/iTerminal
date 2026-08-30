# M9.10 Router PostgreSQL cold-start recovery verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 16, a cold-start degraded Router process, one healthy Router process, two Runtime processes, a silent TCP blackhole, and real node-pty/zsh execution).** The production Router binds its Unix RPC socket while PostgreSQL is unreachable, rejects routed work before database/owner side effects, retries migration with bounded backoff, and transitions the same process to READY after connectivity returns.

## Environment and commands

- Disposable PostgreSQL 16 `iterminal_test` on `127.0.0.1:55432`
- Two Runtime processes and one healthy Router use direct database paths
- The cold Router starts through a proxy already in `BLACKHOLE` mode
- Router query timeout: 300 ms; health/reconnect intervals: 100/50/50 ms

```bash
pnpm typecheck
pnpm exec vitest run \
  apps/runtime-router/src/postgres-recovery-supervisor.test.ts \
  apps/runtime-router/src/server.test.ts

ITERM_DATABASE_URL=postgresql://iterminal:iterminal@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    apps/runtime-router/src/process-chaos.test.ts

pnpm verify
git diff --check
```

- Supervisor and Router classification regression: 2 files / 5 tests passed.
- Independent-process M9 chaos regression: 1 file / 6 scenarios passed.
- Full repository quality gate: 21 files / 84 tests passed; 25 files / 70 tests skipped by explicit environment gates.
- Verification-document audit: 35 milestone reports passed.
- Production build passed; Vite retained the existing non-blocking 543.01 kB Console chunk warning.

## Failures observed during closure

- The first full run rejected unsafe test matchers in the new supervisor unit test; the assertions were changed to capture typed failures and invoke methods through bound arrow callbacks.
- A later full run exposed an existing M4 fixture race: under parallel load, `sleep 10` could finish naturally before the interrupt assertion and report `COMPLETED`. The isolated test passed, confirming that the control path was intact; the fixture duration was raised to 30 seconds so a broken interrupt now fails by timeout instead of producing a false completion. The final full quality gate then passed with the counts above.

## Proven scenarios

| Boundary                   | Result                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| Cold socket lifecycle      | Router binds its stable Unix socket before PostgreSQL migration succeeds                 |
| Degraded request gate      | Root create returns retryable route-phase `RUNTIME_UNAVAILABLE` immediately              |
| Bounded state metadata     | Response carries component, operation, database phase, attempt, and optional retry delay |
| No creation side effect    | Degraded root create leaves zero intent, placement, Session, and PTY                     |
| Background retry           | Failed migration enters bounded `UNAVAILABLE`/`CONNECTING` attempts without process exit |
| Healthy-path independence  | Other Router executes real zsh and creates a Session while cold Router remains degraded  |
| Stale-stream reset         | `CUT` removes blackholed connections before `FORWARD` restores the path                  |
| Same-process readiness     | Original cold Router reports PostgreSQL READY without restart or socket replacement      |
| Exact-key recovery         | Original failed create key commits once after readiness and consumes one placement       |
| Recovered live execution   | Recovered Router routes a real zsh execution to `COMPLETED`                              |
| Graceful shutdown ordering | RPC admission, supervisor loop, and route pool close without an orphan retry loop        |

## Not proven

- PostgreSQL minority/quorum, replication lag, promotion, multiple database endpoints, or split-brain behavior.
- Kubernetes/systemd readiness integration, external load-balancer draining, alerting, or production SLOs.
- Repeated long-duration flapping, retry storms, circuit-breaker shedding, database saturation, or CPU starvation.
- Correlated Router/owner/RabbitMQ outage, hostile-key retention, sustained rolling drain, long soak, M9 L4, or release readiness.
