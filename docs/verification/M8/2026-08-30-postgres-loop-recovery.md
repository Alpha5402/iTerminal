# M8.7 messaging-loop PostgreSQL recovery verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17 process stop/start, real Outbox relay and Execution Worker child processes, RabbitMQ quorum queues, Unix RPC, node-pty/zsh, degraded cold start, and post-recovery dispatch).** A running relay and Worker both detect database loss, stay alive, pause durable polling/consumption, reconnect after the same database container returns, and execute newly admitted work once. Both standalone processes can also start while PostgreSQL is down; the Worker does not connect a RabbitMQ consumer until the durable Inbox is available.

This proves the single-node M8.7 messaging-loop PostgreSQL recovery slice. It does not prove exactly-once publication, primary failover, network partitions, multi-worker fencing, or the full M8 production L4 gate.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- PostgreSQL: 17-alpine, disposable `iterminal_test` database retained across container stop/start
- RabbitMQ: 4.3-alpine, isolated per-test quorum topology
- Runtime: real Unix RPC daemon with external queue dispatch and PostgreSQL durability
- Loop processes: separate `tsx` child processes for `apps/outbox-relay/src/main.ts` and `apps/execution-worker/src/main.ts`
- Shell/PTY: real zsh Session and filesystem side effects
- Failure injection: `docker stop --time 1 compose-postgres-1`, followed by `docker start`

The suite refuses any database not named exactly `iterminal_test` and requires an explicit `ITERM_TEST_POSTGRES_CONTAINER`. The PostgreSQL container is restored in `finally`; the test must never target production state. Queue names include a random test prefix and are removed during cleanup.

## Command and result

```bash
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
ITERM_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5673 \
ITERM_TEST_POSTGRES_CONTAINER=compose-postgres-1 \
pnpm test:m8:postgres-loops
```

- M8.7 PostgreSQL messaging-loop recovery: 2 tests passed.
- The first real run exposed a driver edge: one `pg-pool` reconnect migration failed with `Connection terminated unexpectedly` and no SQLSTATE. The availability classifier now recognizes a narrow list of pg transport messages in addition to SQLSTATE class 08, administrator shutdown codes, and Node network codes. Other errors remain fatal.

## Proven scenarios

| Scenario               | Result                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Running relay outage   | Health/poll failure changes relay PostgreSQL state to `DISCONNECTED`; the original child process remains alive                                         |
| Running Worker outage  | Health failure closes the current RabbitMQ consumer generation, returns unacknowledged deliveries to the broker, and prevents a database-less hot loop |
| Same-process recovery  | Both original child PIDs report a second PostgreSQL connection; the Worker creates a second RabbitMQ consumer generation                               |
| Runtime coordination   | Runtime owner independently converges old Session state to `BROKEN`; loop recovery does not resurrect the old PTY                                      |
| Post-recovery dispatch | A replacement Session's queued Execute reaches the real zsh exactly once and its durable Inbox attempt count is one                                    |
| Cold relay startup     | Relay starts in degraded `DISCONNECTED` state while PostgreSQL is stopped and becomes connected without process restart                                |
| Cold Worker startup    | Worker stays alive with PostgreSQL disconnected and does not connect to RabbitMQ until migration/health succeeds                                       |
| Durable backpressure   | No in-memory message queue is introduced; PostgreSQL Outbox rows and RabbitMQ deliveries remain the retry sources                                      |
| Process cleanup        | SIGTERM closes loop/consumer waits before repository Pools; PostgreSQL is restored and isolated RabbitMQ topology is deleted                           |

## Semantics retained

- A confirmed RabbitMQ publish whose `published_at` update is not durably known may be published again after its Outbox claim lease expires.
- Consumer Inbox identity plus current durable Execution inspection remains the duplicate-dispatch boundary.
- The supervisor retries connectivity/migration; it never replays Execute/Input/Control or claims a Shell side effect succeeded.
- Runtime owner recovery and messaging-loop recovery remain separate responsibilities.

The existing M8.2 dispatch suite covers a confirmed-but-unmarked Outbox message being delivered again without a second PTY write. This M8.7 suite reuses that invariant but does not inject database loss at every individual `markPublished`, Inbox, or Runtime transaction boundary.

## Not proven

- TCP blackhole, DNS failure, asymmetric partition, TLS/auth rotation, primary failover, replica promotion, split brain, or connection storms.
- Disk-full/read-only database modes, transaction ID exhaustion, migration lock contention, corrupt pages, or every commit-result ambiguity window.
- Exactly-once broker publication or exactly-once shell delivery.
- RabbitMQ quorum leader failure during the same database outage, cross-service correlated failure, or long-duration soak.
- Multiple Runtime owners/Workers, lease fencing, owner routing, capacity limits, metrics, alerts, or operator repair.
- Human Console or model-driven L3 collaboration path.
