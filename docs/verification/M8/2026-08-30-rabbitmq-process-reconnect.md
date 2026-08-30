# M8.5 RabbitMQ process reconnect verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, RabbitMQ 4.3 process stop/start, Unix RPC, node-pty/zsh, Outbox relay, and Execution Worker integration).** The same relay, Worker, and Runtime instances survive a single-node RabbitMQ container restart. An Execute admitted while the broker is down remains in the durable Outbox, is dispatched after reconnect, and writes its Shell side effect exactly once. A Worker started while RabbitMQ is unavailable also connects after the broker returns without a Worker restart.

This proves the M8.5 local single-node broker reconnect slice. It does not prove PostgreSQL process-outage reconciliation, network partition behavior, quorum leader failover, or the full M8 production L4 gate.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- PostgreSQL: 17-alpine, disposable `iterminal_test`
- RabbitMQ: 4.3-alpine, disposable single-node broker
- Shell/PTY: real zsh through node-pty
- Failure injection: `docker stop --time 1 compose-rabbitmq-1`, followed by `docker start`

The suite refuses any database not named exactly `iterminal_test` and requires an explicit `ITERM_TEST_RABBITMQ_CONTAINER`. The test restores the named broker container in `finally`; it must never target a production broker.

## Commands and results

```bash
docker compose -f infra/compose/m8-messaging.yml up -d --wait
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
ITERM_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5673 \
ITERM_TEST_RABBITMQ_CONTAINER=compose-rabbitmq-1 \
pnpm test:m8:reconnect
```

- M8.5 broker reconnect: 2 tests passed.
- During development, the first outage run exposed a concurrent consumer shutdown hang between the supervisor and consumer generation. Making `close()` idempotent removed that lifecycle race; the full outage suite then passed repeatedly.

## Proven scenarios

| Scenario                         | Result                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Running broker process restart   | RabbitMQ is stopped after one successful Execute, then restarted without recreating relay, Worker, Runtime, Session, or PTY                          |
| Durable admission during outage  | Execute admission commits Action/Execution/Event/Outbox while RabbitMQ is unavailable; no Shell side effect occurs before delivery                   |
| Publisher reconnect              | Failed publish invalidates the confirm connection; a later durable Outbox attempt creates a new connection and marks the stable message ID published |
| Consumer reconnect               | Connection close moves Worker diagnostics to `DISCONNECTED`; the supervisor declares topology and consumes again after recovery                      |
| No transport-layer blind replay  | The failed `publish` call is not retried internally; Outbox retry plus Consumer Inbox handle possible duplicate delivery                             |
| Exact Shell-side-effect boundary | The post-outage command reaches the owner-local PTY once; one `execution.write_attempted` Event and one Inbox processing attempt are observed        |
| Cold broker startup              | Worker starts in degraded state while the broker is down, remains alive, and reaches `CONNECTED` after broker startup                                |
| Bounded reconnect                | Connect attempts use capped exponential backoff with jitter; publisher cooldown prevents one connection attempt per claimed Outbox row               |
| Deterministic shutdown           | Reconnect delay is abortable and consumer close is idempotent, so supervisor and active consumer can close concurrently without hanging              |

## Failure semantics observed

- Reconnect restores availability; it does not convert ambiguous AMQP delivery into exactly-once delivery.
- Publisher failure is returned to the Outbox relay. Only a later database claim can republish the stable message ID.
- Unacknowledged consumer deliveries remain RabbitMQ's responsibility and are rechecked through Consumer Inbox plus current PostgreSQL state.
- A Worker may be alive but degraded before its first broker connection; connection-state diagnostics distinguish this from `CONNECTED`.

## Not proven

- PostgreSQL server process kill, pool recovery across a real outage, owner-wide durability circuit breaking, or durable reconciliation before new admission.
- TCP blackhole, DNS failure, asymmetric network partition, TLS/auth rotation, connection blocking alarms, disk/memory watermark, or broker resource exhaustion.
- Multi-node RabbitMQ quorum leader loss, minority partition, queue repair, rolling upgrade, or policy migration.
- Long-duration outage/soak, reconnect storm across many relay/Worker processes, jitter distribution, capacity sizing, metrics, alerts, or operator repair.
- Multi-worker leases/fencing, authentication, authorization, approvals, secret redaction, or release operations.
- Human Console or model-driven L3 collaboration path.
