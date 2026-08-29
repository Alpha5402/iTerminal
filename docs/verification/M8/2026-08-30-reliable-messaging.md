# M8.1 reliable messaging verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, RabbitMQ 4.3, Outbox relay process, and Consumer Inbox integration).** Transactional Outbox rows can be claimed concurrently, published with confirms, recovered after a lost mark, deduplicated at the consumer, retried without a hot requeue loop, validated against current database state, and dead-lettered when invalid.

This proves the reliable notification plane. It does not prove that a RabbitMQ consumer owns or writes the live PTY; M4.1 still dispatches locally after durable admission.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- PostgreSQL: 17-alpine, disposable `iterminal_test`
- RabbitMQ: 4.3-alpine, disposable single-node broker
- Client: amqplib 2.0.1 using AMQP 0-9-1 confirm and manual-ack channels
- Queues: durable quorum main/retry/DLQ queues with per-test prefixes

The suite refuses to mutate any database not named exactly `iterminal_test`. PostgreSQL data is tmpfs-backed; test exchanges and queues are deleted after each scenario.

## Commands and results

```bash
docker compose -f infra/compose/m8-messaging.yml up -d --wait
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
ITERM_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5673 \
pnpm test:m8:messaging
```

- M8.1 integration: 5 tests passed.

## Proven scenarios

| Scenario                   | Result                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Concurrent claim           | Two publishers claim 20 rows with no duplicate claim                                    |
| Confirm before mark        | Broker receives a confirmed message before PostgreSQL is marked published               |
| Publisher crash recovery   | Lost claim expires; a new publisher republishes and marks the row                       |
| Duplicate delivery         | Stable message ID invokes the injected handler once; completed Inbox duplicate is ACKed |
| Content conflict           | Same message ID with changed canonical content is rejected to the DLQ                   |
| Publish audit              | Outbox mark and `outbox.published` Session Event commit together                        |
| Transient consumer failure | Inbox releases; confirmed retry queue redelivers; second attempt succeeds               |
| Delayed message            | Consumer reloads RUNNING state, records `IGNORED_STALE`, and never invokes handler      |
| Poison message             | Invalid JSON is rejected without requeue and reaches the DLQ                            |
| Broker unavailable         | Publish failure leaves Outbox unpublished with attempts/error/next retry metadata       |
| Standalone relay lifecycle | Real relay process publishes pending work and exits cleanly on `SIGTERM`                |

## Failure semantics observed

- Database commit before publisher availability leaves durable pending Outbox work.
- Broker confirmation without a subsequent database mark produces a deliberate duplicate after lease recovery.
- Consumer side effects are guarded by a durable Inbox lease and canonical payload hash.
- Retry publication is confirmed before ACKing the original delivery.
- Invalid, conflicting, or exhausted deliveries do not requeue forever.
- Delayed messages cannot override current Session/Execution state.

## Not proven

- RabbitMQ-triggered PTY dispatch, owner-specific routing, or fencing; M4.1 still dispatches locally.
- Worker crash immediately before/after PTY write or before Shell start marker.
- Input/Control post-write process crash and non-replay evidence.
- Real PostgreSQL outage while a consumer owns an Inbox lease.
- Real RabbitMQ process kill during confirm, reconnect supervision, partition, quorum leader loss, or long outage soak.
- Multi-worker fairness, authentication/TLS, production RabbitMQ policies, metrics/alerts, or release operations.
- Human Console or model-driven L3 path.
