# M9.1 Runtime owner registry verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, Runtime daemon Unix RPC, node-pty/zsh, concurrent database clients, and boot-incarnation failure injection).** A durable Runtime registers one exact owner/instance/epoch before owner recovery, heartbeats and drains with PostgreSQL time, rejects a concurrent live incarnation, and destroys local PTY state after its registry identity is replaced.

This proves the M9.1 registry and daemon-lifecycle foundation. It does not implement the selected central Router, generation-scoped Session lease/fencing, cross-owner forwarding, or the M9 L4 multi-Worker exit gate.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- pnpm: 10.33.2
- PostgreSQL: 17-alpine, disposable `iterminal_test`, tmpfs-backed, bound to `127.0.0.1:55432`
- RabbitMQ regression broker: 4.3-alpine, disposable, bound to `127.0.0.1:5673`
- Runtime transport: separate absolute mode-`0600` Unix sockets per daemon
- Shell/PTY: real zsh through node-pty

Database suites refuse to mutate any database not named exactly `iterminal_test`. Registry and Runtime files run with one test Worker because they migrate and truncate the same disposable database.

## Commands and results

```bash
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm test:m9:registry

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
  packages/persistence-postgres/src/postgres-runtime-owner-registry.test.ts \
  apps/runtime-daemon/src/owner-registry.test.ts \
  apps/runtime-daemon/src/durable-runtime.test.ts \
  apps/runtime-daemon/src/interaction-crash.test.ts \
  apps/runtime-daemon/src/interaction-policy.test.ts \
  apps/runtime-daemon/src/session-fork-durable.test.ts \
  apps/runtime-daemon/src/session-rebuild-durable.test.ts

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
ITERM_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5673 \
  pnpm exec vitest run --maxWorkers=1 \
  apps/execution-worker/src/execution-worker.test.ts \
  apps/runtime-daemon/src/admission-backpressure.test.ts

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
ITERM_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5673 \
  pnpm exec vitest run --maxWorkers=1 \
  apps/execution-worker/src/network-partition.test.ts -t 'PostgreSQL blackhole'

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
ITERM_TEST_POSTGRES_CONTAINER=iterminal-m9-outage-postgres \
  pnpm exec vitest run --maxWorkers=1 \
  apps/runtime-daemon/src/postgres-outage.test.ts

pnpm verify
```

- Focused M9.1 registry/daemon suite: 2 test files / 4 tests passed.
- Serialized M9.1 plus affected PostgreSQL/PTY regression: 7 test files / 11 tests passed.
- Affected RabbitMQ owner-dispatch/backpressure regression: 2 test files / 8 tests passed.
- Silent PostgreSQL blackhole regression: 1 test passed / 1 unrelated RabbitMQ case filtered out; owner heartbeat retained the configured 1 s database deadline and the full scenario recovered within its existing 8 s bound.
- PostgreSQL process stop/start regression with persistent test storage: 1 file / 2 tests passed on the final run.
- Full repository quality gate: 19 test files / 77 tests passed; 20 environment-gated files / 51 tests skipped; 26 milestone reports verified; Prettier, ESLint, TypeScript, and production build passed.

## Proven scenarios

| Scenario                 | Result                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial registration     | Missing logical owner inserts boot instance at registry epoch 1 with absolute Unix endpoint and `ACTIVE` status                                                              |
| Idempotent refresh       | The exact same instance/endpoint refreshes its database-time lease without advancing epoch; a draining instance is not accidentally reactivated                              |
| Heartbeat and load fact  | Daemon heartbeat advances row version and reports active Session count from durable Session state                                                                            |
| Concurrent live conflict | A second boot instance for the same owner remains unavailable and cannot run durable recovery or break the first daemon's READY Session                                      |
| Drain and stop           | Graceful close excludes new placement with `DRAINING`, closes Sessions while heartbeat remains live, then persists `STOPPED`                                                 |
| Expiry and replacement   | Expired or explicitly stopped owners disappear from live resolution; replacement advances the monotonic registry epoch                                                       |
| Concurrent replacement   | Two database clients race after expiry; exactly one acquires epoch 2 and the loser receives `OWNER_CONFLICT`                                                                 |
| Stale identity           | Heartbeat, drain, and stop require exact owner/instance/epoch; replaced identities receive `OWNER_LEASE_LOST` and cannot mutate the new row                                  |
| Owner-wide safety        | A daemon whose exact registry identity is replaced detects heartbeat failure, marks its local generation `BROKEN`, closes its PTY, and rejects RPC admission                 |
| Existing M8 recovery     | Short test leases plus explicit readiness preserve crash replacement, queue dispatch, admission rollback, and backpressure semantics without bypassing the new conflict rule |

## Exploratory failures resolved

- The first registry query used a cast on the `active_session_count` alias in `ORDER BY`; PostgreSQL rejected that expression. The query now orders by the selected column ordinal and owner ID.
- A conflict test assumed the daemon would remain in one transient `UNAVAILABLE` phase. Retry supervision may already move it to `CONNECTING`, so the stable assertions are now: never READY, no registration, and RPC rejects with `RUNTIME_UNAVAILABLE`.
- Existing crash-replacement tests assumed a new process could recover immediately. That contradicted the new live-owner lease. Fixtures now use bounded short leases and await readiness after expiry; historical Sessions remain visible as M7.2 `BROKEN` projections rather than disappearing.
- The first RabbitMQ regression rerun exposed the same missing lease-expiry wait in the database-lock admission scenario. Its replacement now uses a short registry lease and explicit readiness; the final 8-test regression passes.
- Code review found that the new registry pool initially kept a 30 s query timeout instead of inheriting the daemon's configured database statement timeout. The option is now propagated; the existing silent-blackhole test passed with its 1 s query deadline and 8 s end-to-end bound.
- The first full gate inside the filesystem sandbox could not create Unix/loopback listeners (`listen EPERM`); the same command outside that network restriction passed. The first two M8.6 infrastructure attempts were invalid because an auto-removed and then tmpfs-backed PostgreSQL container cannot preserve data across stop/start. A persistent temporary volume produced the real scenario. One otherwise-passing run reported a transient pg connection-termination event; an immediate full scenario rerun passed without unhandled errors.

## Architecture boundary verified

- Stable `ownerId`, boot-unique `instanceId`, and monotonic registry epoch are separate facts.
- Registration precedes durable owner reconciliation. A live registry conflict cannot mutate durable Session state through recovery.
- PostgreSQL time determines lease expiry; process clocks do not decide routability.
- `DRAINING` is excluded from new placement but remains resolvable for existing exact-owner operations during graceful close.
- Registry epoch fences only the registry row. It is not accepted as a Session mutation token and cannot undo PTY bytes.
- The PTY remains process-local truth. Registry replacement causes conservative shutdown, not PTY migration or resurrection.

## Not proven

- Central Router process, stable Router Unix RPC, durable Session-owner lookup, cross-owner forwarding, endpoint reachability probing, or route retry policy.
- Generation-scoped Session lease, renewal, fencing token, or owner/instance/generation/token checks in every Action/Execution/interaction/resize/lifecycle database mutation.
- Rejection of every stale owner durable write after route expiry, especially the narrow expiry-to-next-heartbeat interval.
- Three or more Runtime owners, fair new-Session placement, actor/session rate limiting, rolling drain under load, asymmetric partition, correlated DB/MQ outage, or long soak.
- Remote endpoints, mutual authentication, authorization, approvals, secret channels/redaction, TLS, hostile local users, or release hardening.
- Live PTY failover, old process-group reclamation after host partition, or exactly-once Shell effects.
- Browser Human or model-driven Agent L3 path through a central Router.
