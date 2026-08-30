# M9.3 generation-scoped Session fencing verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, Runtime daemon Unix RPC, node-pty/zsh, exact owner replacement, Session-lease revocation, and concurrent durable clients).** One Session generation receives one globally monotonic fencing token bound to an exact Runtime owner incarnation. Every production live-state mutation validates that fence in its PostgreSQL transaction; a replaced owner or revoked lease cannot commit stale state, and the local Runtime closes its PTY best-effort before recovery exposes only a new Session rebuild path.

This proves the M9.3 local durable-write fencing slice. It does not prove live PTY migration, exactly-once external effects, remote process reclamation after host partition, or the M9 L4 multi-Worker exit gate.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- pnpm: 10.33.2
- PostgreSQL: 17-alpine, disposable `iterminal_test`, tmpfs-backed, bound to `127.0.0.1:55432`
- RabbitMQ regression broker: 4.3-alpine, disposable, bound to `127.0.0.1:5673`
- Runtime transport: separate absolute mode-`0600` Unix sockets
- Shell/PTY: real zsh through node-pty

Database suites refuse to mutate any database not named exactly `iterminal_test`. Shared PostgreSQL tests use one Vitest Worker. Startup migration now takes a database advisory lock and skips versions already present in `schema_migrations`, so concurrent daemons do not rerun table-altering DDL during recovery.

## Commands and results

```bash
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm test:m9:fencing

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
  packages/persistence-postgres/src/postgres-runtime-repository.test.ts \
  packages/persistence-postgres/src/postgres-observation-repository.test.ts \
  packages/persistence-postgres/src/postgres-interaction-guard.test.ts \
  packages/persistence-postgres/src/postgres-terminal-geometry.test.ts \
  packages/persistence-postgres/src/postgres-session-fencing.test.ts \
  apps/runtime-daemon/src/durable-runtime.test.ts \
  apps/runtime-daemon/src/interaction-policy.test.ts \
  apps/runtime-daemon/src/resize.test.ts \
  apps/runtime-daemon/src/session-fork-durable.test.ts \
  apps/runtime-daemon/src/session-rebuild-durable.test.ts \
  apps/runtime-daemon/src/owner-registry.test.ts

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
ITERM_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5673 \
  pnpm exec vitest run --maxWorkers=1 \
  apps/runtime-daemon/src/interaction-crash.test.ts \
  apps/runtime-daemon/src/admission-backpressure.test.ts \
  packages/queue-rabbitmq/src/rabbitmq-messaging.test.ts

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
ITERM_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5673 \
  pnpm test:m9:router

pnpm verify
```

- Focused fencing persistence/daemon suite: 2 test files / 5 tests passed.
- Affected PostgreSQL/PTY suite: 11 test files / 26 tests passed.
- M8 crash/admission/RabbitMQ regression: 3 test files / 12 tests passed.
- M9 Router/MCP/queue regression: 4 test files / 10 tests passed.
- Static gates before the final repository gate: Prettier, ESLint, and TypeScript passed.
- Full repository quality gate: 20 test files / 80 tests passed; 23 environment-gated files / 58 tests skipped; 28 milestone reports verified; Prettier, ESLint, TypeScript, and production build passed. The build retains the existing advisory for one 542.81 kB minified Console chunk.

## Proven scenarios

| Scenario            | Result                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token allocation    | Two Session generations receive distinct positive tokens; the later acquisition has a greater `bigint` token, represented as a string at the TypeScript boundary to avoid precision loss                                                 |
| Exact-set renewal   | Only the daemon's supplied local `(session, generation, token)` set renews; one tampered token aborts the whole renewal transaction without partially advancing another lease                                                            |
| Expiry bound        | Session lease expiry is computed with PostgreSQL time and is never later than the current Runtime owner lease expiry                                                                                                                     |
| Graceful release    | Session close persists lifecycle state and releases its lease in the same transaction before owner stop                                                                                                                                  |
| Stale owner         | After exact owner replacement, the old token receives non-retryable `SESSION_LEASE_LOST`; its attempted Event count remains zero                                                                                                         |
| Revoked Session     | Manual lease revocation is detected by renewal, trips the owner-wide durability circuit, closes a real sleeping zsh PTY, and leaves the durable Session `BROKEN` with its active Execution `UNKNOWN`                                     |
| Recovery boundary   | The current replacement identity releases old leases and marks old live generations broken; continued work uses a distinct new Session ID/generation 1 rather than taking over the old PTY                                               |
| Execution CAS       | A stale expected Execution version rolls back the terminal transition; the exact version succeeds and increments once under the same Session fence                                                                                       |
| Production coverage | Session lifecycle, Execute admission/write/running/terminal state, Input, Control, Resize, interaction policy/Guard, Events, PTY output/artifacts/screen version, checkpoints, snapshots, and live-parent fork audit all require a fence |
| Existing paths      | Durable Runtime, interaction, resize, fork/rebuild, crash/admission/RabbitMQ, central Router, official MCP, and queue Worker regressions retain their prior behavior                                                                     |

## Exploratory failures resolved

- The first combined run was executed inside the filesystem/network sandbox. PostgreSQL TCP and Unix listeners failed with `EPERM`; the identical command outside that restriction exercised the real services.
- One M4 persistence test read a screen revision immediately before asynchronous Python prompt output advanced it. The Runtime correctly returned `SCREEN_CHANGED`; because that test verifies durable Input rather than freshness CAS, the fixture now omits the optional expected screen version. Dedicated freshness tests remain unchanged.
- A combined M8 rerun initially used a nonexistent RabbitMQ `iterminal_test` user and received broker `403 ACCESS_REFUSED`. The disposable broker's actual local `guest` credential produced the passing 12-test run.
- A repeated 11-file run exposed a real PostgreSQL deadlock between owner recovery and another daemon unconditionally replaying old `ALTER TABLE` migration SQL. The migrator now holds one database advisory lock on one connection and executes only missing schema versions. The owner replacement/recovery scenario and the full affected suite pass after the fix.

## Architecture boundary verified

- Runtime owner identity `(ownerId, instanceId, registryEpoch)`, Session fence `(sessionId, generation, fencingToken)`, and Execution expected `version` are separate guarantees.
- The transaction guard locks the current Runtime owner row before the exact Session lease row. Acquisition, renewal, mutation, release, replacement, and recovery use that owner-first order.
- The production observation repository requires a fence for PTY output; lower-level test/query repositories may opt out only when they are not used as `RuntimeDurability`.
- Graceful close and `BROKEN` terminal transitions release the lease transactionally. Crash leaves it to expire; only the current owner identity may perform recovery.
- Output Event persistence and screen-version advancement are separately fenced transactions. A takeover between them may leave the Event committed while the later screen update is rejected; it cannot permit a stale post-takeover state write.
- Write-attempt persistence precedes PTY mutation, but lease loss after that commit cannot prove whether terminal bytes were consumed. The result remains conservative `UNKNOWN`/`DELIVERY_UNKNOWN`, never automatic replay or an exactly-once claim.
- A lost generation is never re-leased to another live PTY. Rebuild creates a distinct Session and immutable lineage.

## Not proven

- Three or more Runtime owners under concurrent placement, fairness/capacity weights, per-actor/session rate limits, overload shedding, or rolling drain under sustained load.
- Asymmetric or minority network partition, correlated PostgreSQL/RabbitMQ outage, delayed heartbeat scheduling under CPU pressure, clock/pathological database stalls, or long soak.
- Host-level or remote process-group reclamation after the old machine is unreachable. This slice proves only best-effort local executor/process-group close after lease loss is observed.
- Live PTY migration, takeover of an old generation, or reconstruction of process/REPL/editor state.
- Exactly-once Shell, TTY, filesystem, network, package publication, or other external effects.
- Browser Human Console or autonomous model-driven Agent L3 path through three or more owners.
- Remote endpoints, peer credentials, authentication/TLS, authorization/approval, secret-channel/redaction, hostile local user, or release hardening.
