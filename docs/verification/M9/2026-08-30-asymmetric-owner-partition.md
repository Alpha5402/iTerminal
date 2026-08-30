# M9.6 asymmetric owner database partition verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, one Router process, three Runtime processes, per-owner TCP silent blackhole, connection reset/reconnect, and real node-pty/zsh).** One owner's database partition trips only that owner, removes it from placement after lease expiry, and preserves service on healthy owners; recovery keeps old work `BROKEN/UNKNOWN` and admits only a new Session/PTY.

## Environment and commands

- Disposable PostgreSQL 17 `iterminal_test` on `127.0.0.1:55432`
- Owner B alone connects through `TcpFaultProxy`; Router and owners A/C connect directly
- 500 ms statement timeout, 100 ms health interval, 2,000 ms owner/Session leases

```bash
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    apps/runtime-router/src/process-chaos.test.ts \
    packages/persistence-postgres/src/postgres-runtime-owner-registry.test.ts \
    packages/persistence-postgres/src/postgres-session-fencing.test.ts \
    apps/runtime-router/src/runtime-router.test.ts

pnpm verify
```

- Affected regression: 4 files / 11 tests passed, including both independent-process scenarios.
- Full repository quality gate: 20 enabled files / 80 tests passed; 25 environment-gated files / 65 tests skipped; 31 milestone reports verified; production build passed.
- The existing non-blocking Console chunk-size warning remains at 542.81 kB.

## Proven scenarios

| Scenario         | Result                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Baseline         | Six Sessions place 2/2/2 across independent owners                                           |
| Silent partition | Owner B query deadline trips; its sleeping Shell PID disappears and exact route fails closed |
| Healthy progress | Owner A completes a real command; four new Sessions place 2/2 on A/C only                    |
| Safe reconnect   | Resetting stale TCP streams no longer crashes Runtime on a checked-out Client error          |
| Recovery         | Same process/instance remains epoch 1, victim Session is `BROKEN`, Execution is `UNKNOWN`    |
| New work         | A distinct newly placed owner-B Session executes successfully; victim remains `BROKEN`       |

## Exploratory failure resolved

- Returning a blackholed timed-out stream directly to FORWARD left PostgreSQL protocol state untrustworthy. Recovery now resets old TCP connections before reconnecting.
- That reset exposed an unhandled `error` on a checked-out `pg` Client. Pool creation now installs a Client listener; query failure semantics remain unchanged while the Runtime process survives and recovers.

## Not proven

- PostgreSQL minority/quorum behavior, Router database partition, correlated RabbitMQ loss, or multiple partitioned owners.
- In-flight Router mutation/claim crash, repeated network flapping, CPU-starved heartbeats, database saturation, or long soak.
- Remote process reclamation, live PTY migration, exactly-once effects, authentication, Approval, secrets, or release readiness.
