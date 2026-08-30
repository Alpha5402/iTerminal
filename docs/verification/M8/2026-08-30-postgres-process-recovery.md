# M8.6 PostgreSQL process recovery verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17 process stop/start, Unix RPC, two node-pty/zsh Sessions, Python REPL, owner-wide circuit breaking, Pool reconnection, and durable reconciliation).** A running Runtime detects PostgreSQL loss through its health probe, closes every PTY under the owner, rejects an unjournaled Input before PTY delivery, and exposes degraded RPC readiness. After the same PostgreSQL container returns, the same daemon reconciles old durable generations to `BROKEN/UNKNOWN` before admitting and executing a replacement Session. A daemon started while PostgreSQL is down also remains alive and becomes ready without restart.

This proves the M8.6 Runtime-owner PostgreSQL outage slice. It does not prove database supervision for standalone Outbox relay/Execution Worker loops, primary failover, network partitions, or the full M8 production L4 gate.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- PostgreSQL: 17-alpine, disposable `iterminal_test` with a Docker test volume retained across container stop/start
- Shell/PTY: two real zsh Sessions; one runs a real Python REPL
- Failure injection: `docker stop --time 1 compose-postgres-1`, followed by `docker start`

The suite refuses any database not named exactly `iterminal_test` and requires an explicit `ITERM_TEST_POSTGRES_CONTAINER`. The named database container is restored in `finally`; this test must never target a production database. The compose test volume exists only so a process restart preserves the rows that reconciliation must inspect.

## Commands and results

```bash
docker compose -f infra/compose/m8-messaging.yml up -d --wait
pnpm exec vitest run packages/application/src/runtime-durability.test.ts
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
ITERM_TEST_POSTGRES_CONTAINER=compose-postgres-1 \
pnpm test:m8:postgres-outage
```

- Runtime durability scope tests: 5 tests passed.
- M8.6 PostgreSQL process recovery: 2 tests passed.
- The first real outage run exposed two fixture/runtime defects before passing: the previous tmpfs erased database truth across container restart, and unhandled `pg.Pool` idle-client errors could terminate the process. The test stack now uses a disposable persistent volume, and production Pools install an error listener while query failures still propagate to the circuit.

## Proven scenarios

| Scenario                    | Result                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proactive outage detection  | A bounded health probe detects database loss even while the foreground Python process is otherwise quiet                                                      |
| Owner-wide circuit          | One PostgreSQL outage closes both owner PTYs and changes both in-memory Sessions to `BROKEN`; it is not limited to the Session that would next write          |
| Write-ahead Input rejection | Agent Input containing a Python file side effect is rejected with retryable `RUNTIME_UNAVAILABLE`; no Input Action commits and the file is absent             |
| Active uncertainty          | The already-running Python Execution/Action becomes local `UNKNOWN`; recovery persists `UNKNOWN` rather than claiming completion or replaying Input           |
| Degraded RPC readiness      | The Unix socket remains bound, but Session creation returns retryable `RUNTIME_UNAVAILABLE` while the owner circuit is open                                   |
| Durable reconciliation      | Recovery atomically marks both durable Session generations `BROKEN`, marks the active Execution `UNKNOWN`, and appends `session.broken` Events                |
| Pool reconnection           | The same Runtime daemon and Postgres durability adapters establish replacement connections after container restart                                            |
| Replacement admission       | Only after reconciliation commits does readiness return; a newly created Session executes a real zsh command successfully                                     |
| Broken-history preservation | Graceful daemon close skips old `BROKEN` Sessions, so their durable failure state is not rewritten to `CLOSED`                                                |
| Cold database startup       | A daemon binds RPC in degraded state with zero Sessions while PostgreSQL is down, then migrates/recovers and serves a real Session without process restart    |
| Scope discrimination        | Unit coverage proves infrastructure failure trips every Session, while a durable `DELIVERY_UNKNOWN` conflict remains scoped to its affected Session           |
| Idle Pool errors            | Administrator termination of idle `pg` clients no longer becomes an uncaught process exception; the next probe/query remains the authoritative failure signal |

## Failure semantics observed

- Database availability is an owner-level prerequisite, not a per-Session convenience.
- Health probes never retry Execute/Input/Control. They can only close live ownership and trigger recovery.
- Clearing the circuit requires the durable owner-recovery transaction to commit; successful TCP connection alone is insufficient.
- Old PTYs and generations remain broken after recovery. Service availability returns only through new Sessions.
- PostgreSQL statement timeout code `57014` remains Session-scoped; a connection/admin-shutdown failure is owner-scoped.

## Not proven

- PostgreSQL outage supervision/restart behavior for standalone Outbox relay or Execution Worker processes.
- TCP blackhole, DNS failure, asymmetric network partition, TLS/auth rotation, primary failover, replica promotion, split brain, or connection storms.
- Commit-result ambiguity for every Runtime transition, database disk-full/read-only modes, transaction ID exhaustion, migration lock contention, or corrupt pages.
- Long-duration outage/soak, health-probe sizing, multi-daemon reconnect jitter distribution, metrics, alerts, or operator repair.
- RabbitMQ quorum leader loss, multi-worker leases/fencing, authentication, authorization, approvals, secret redaction, or release operations.
- Human Console or model-driven L3 collaboration path.
