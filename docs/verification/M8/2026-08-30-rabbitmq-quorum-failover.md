# M8.9 RabbitMQ quorum leader failover verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, three RabbitMQ 4.3.5 nodes, quorum leader stop/election, Unix RPC, Outbox relay, Execution Worker, node-pty/zsh, and durable recovery).** The test discovers the main queue's actual leader, makes relay and Worker connect through that broker, stops its container, and completes newly pending Outbox work while the old leader remains down. The resulting Shell side effect, durable PTY write-attempt Event, and Consumer Inbox attempt each occur once.

This proves one local three-node majority-available leader-loss slice. It does not prove minority partition handling, asymmetric routing failures, simultaneous node loss, correlated PostgreSQL failure, or long-duration production soak.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- PostgreSQL: 17-alpine, disposable database named exactly `iterminal_test`
- RabbitMQ: three 4.3.5-alpine nodes with persistent identities and a shared Erlang cookie
- Queue topology: durable quorum main/retry/DLQ queues under a per-test prefix
- Runtime path: external queue dispatch, real Unix RPC, persistent zsh PTY, filesystem side effect
- Test heartbeat: 1 second; reconnect delay: 100–500 ms without jitter

The suite refuses to mutate any database not named exactly `iterminal_test`. Broker URLs are never included in connection-state diagnostics; only the endpoint index is exposed.

## Commands and results

```bash
docker compose -f infra/compose/m8-messaging.yml up -d --wait
bash scripts/run-m8-quorum-test.sh
```

- Cluster setup reports three disk/running nodes, all on RabbitMQ 4.3.5, with no network partitions.
- M8.9 quorum failover: 1 test passed.
- The former leader is restarted in fixture cleanup; CI removes all three cluster volumes in an `always()` cleanup step.

## Proven scenarios

| Scenario                        | Result                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Real leader selection           | `rabbitmq-queues quorum_status` supplies the main queue's current Raft leader; the test does not assume node 1 is leader     |
| Full voter topology             | Before injection, the main queue reports three voter members                                                                 |
| Client targets failed leader    | Broker endpoints are reordered so relay and Worker initially connect through the discovered leader                           |
| Actual broker loss              | Docker stops the leader container with a one-second grace period; the test confirms it is not running                        |
| Replacement election            | A surviving node reports a different Raft leader while at least two voter rows remain visible                                |
| Multi-endpoint recovery         | Worker consumer and relay publisher leave endpoint index 0 and connect through a surviving endpoint                          |
| Pending durable work            | Runtime admits a new Execute after leader loss; the Outbox row needs at least two publication attempts and becomes published |
| Progress before old-node return | Execution reaches `COMPLETED` and the side effect is observed while Docker still reports the former leader stopped           |
| No duplicate Shell write        | The failed-over Execute has one `execution.write_attempted`, one Inbox attempt, and one filesystem append                    |

## Configuration added

- Supervised RabbitMQ publisher and consumer accept either one URL or an ordered non-empty URL list.
- `ITERM_RABBITMQ_URLS` provides a comma-separated endpoint list for relay and Worker; `ITERM_RABBITMQ_URL` remains the backward-compatible fallback.
- Each failed connection advances to the next endpoint round-robin. Connection state reports `endpointIndex`, never the URL or credentials.
- `infra/compose/m8-rabbitmq-cluster.yml` and `scripts/configure-m8-rabbitmq-cluster.sh` provide the isolated test cluster; `scripts/run-m8-quorum-test.sh` drives the scenario locally and in CI.

## Semantics retained

- RabbitMQ remains an at-least-once wake-up plane; endpoint rotation is not an exactly-once mechanism.
- A failed publisher confirm can be ambiguous. The Outbox lease may publish again, while Consumer Inbox and current PostgreSQL Execution state prevent duplicate dispatch.
- Queue leadership and client endpoint selection are transport facts, not Session owner or PTY fencing facts.
- A lost live PTY still becomes `BROKEN/UNKNOWN`; broker election does not migrate or resurrect it.

## Not proven

- Minority or pause-minority behavior, asymmetric/multi-hop partitions, packet delay/reordering/duplication, DNS/TLS/NAT failures, or partial loss.
- Two simultaneous RabbitMQ node failures, rolling upgrades, policy/schema migration, replica repair, disk/memory alarms, or queue corruption.
- Retry/DLQ leadership changes during active poison-message handling, every publisher-confirm ambiguity point, or high-volume recovery ordering.
- PostgreSQL primary failover, correlated PostgreSQL/RabbitMQ loss, multi-owner fencing, or split-brain prevention.
- Long-duration outage/soak, capacity, reconnect thundering herd, metrics/alerts, operator repair, authentication/authorization, or release operations.
- Human Console, model-driven Agent collaboration, cross-platform cluster behavior, or the full M8 L4 exit gate.
