# M8.8 silent network blackhole recovery verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, RabbitMQ 4.3 quorum queues, local bidirectional TCP byte-drop proxies, Unix RPC, Outbox relay, Execution Worker, node-pty/zsh, and durable recovery).** Established database and broker sockets remain open while the proxy silently discards traffic in both directions. RabbitMQ heartbeat and PostgreSQL query deadlines surface bounded unavailable states; forwarding recovery reconnects the same service handles without replaying a PTY command.

This proves the single-host symmetric TCP blackhole slice. It is stronger than process stop/start evidence but does not prove asymmetric routing failures, real firewall/NAT behavior, RabbitMQ quorum leader failover, PostgreSQL primary failover, or long-duration production soak.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- PostgreSQL: 17-alpine, disposable `iterminal_test`
- RabbitMQ: 4.3-alpine, isolated per-test quorum topology
- Fault injection: in-process TCP proxy on ephemeral loopback ports
- `BLACKHOLE`: both accepted sockets stay open; downstream and upstream bytes are read and discarded; no FIN/RST and no container stop
- Runtime path: external queue dispatch, real Unix RPC, persistent zsh PTY, filesystem side effects
- Test heartbeat: 1 second; production default: 5 seconds
- Test PostgreSQL connection/query deadline: 1,000 ms; production messaging defaults remain 5,000/30,000 ms

The test suite refuses databases not named exactly `iterminal_test`. Direct database and RabbitMQ URLs are used only for assertions and isolated topology cleanup; application components connect through the fault proxy during the relevant scenario.

## Commands and results

```bash
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
ITERM_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5673 \
pnpm test:m8:network
```

- TCP proxy unit and PostgreSQL availability classification: 10 tests passed.
- M8.8 real network blackhole recovery: 2 tests passed.
- Both scenarios assert that unavailable state is surfaced in less than eight seconds under their one-second test settings.

## Proven scenarios

| Scenario                            | Result                                                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real silent fault                   | Proxy discards bidirectional bytes on established sockets while both PostgreSQL and RabbitMQ containers remain healthy                                    |
| AMQP heartbeat detection            | Worker consumer changes to `DISCONNECTED` within the bounded test window without receiving TCP close/reset                                                |
| Outbox admission during broker loss | Runtime durably accepts an Execute; relay records publish failure/backoff and no PTY side effect occurs while RabbitMQ is unreachable                     |
| Broker recovery                     | Worker consumer and relay publisher establish replacement connections; pending Outbox work completes                                                      |
| No duplicate shell write            | Blackholed RabbitMQ scenario produces one `execution.write_attempted`, one Inbox attempt, and one real filesystem append                                  |
| PostgreSQL query deadline           | Runtime, relay, and Worker all surface unavailable state under a socket that remains open                                                                 |
| Owner safety circuit                | Database blackhole breaks the old Session and RPC refuses replacement admission before durable recovery                                                   |
| Loop pause                          | Relay stops claiming and Worker withdraws its consumer while PostgreSQL durable Inbox/inspection truth is unreachable                                     |
| Database recovery ordering          | Runtime reconciliation, relay database readiness, and Worker consumer readiness all complete before a replacement Session is exercised                    |
| Replacement-only execution          | Old PTY stays `BROKEN`; a new Session executes after recovery, with exactly one Inbox attempt and one filesystem append                                   |
| Proxy semantics                     | Unit coverage proves bytes sent during `BLACKHOLE` are absent after `FORWARD` resumes while the original client socket was not explicitly closed by proxy |

## Configuration added

- RabbitMQ connections request a five-second heartbeat when the URL has no explicit `heartbeat` query.
- `ITERM_RABBITMQ_HEARTBEAT_SECONDS` sets a positive relay/Worker heartbeat preference.
- `ITERM_DATABASE_CONNECTION_TIMEOUT_MS` bounds messaging Pool connection/checkout waits.
- `ITERM_DATABASE_OPERATION_TIMEOUT_MS` bounds messaging queries and server statements.
- Runtime continues to use `ITERM_DATABASE_STATEMENT_TIMEOUT_MS` for its durability queries.

## Semantics retained

- Heartbeat timeout does not prove whether an in-flight RabbitMQ publish committed.
- PostgreSQL query timeout does not prove an in-flight durable mutation committed.
- Supervisors restore connectivity only; they never replay Execute/Input/Control.
- Outbox lease, Consumer Inbox, current Execution inspection, owner recovery, and `UNKNOWN/BROKEN` remain authoritative.

## Not proven

- Asymmetric partition, packet delay/reordering/duplication, partial loss, DNS poisoning, MTU failure, TLS middleboxes, NAT expiry, or multiple routed hops.
- RabbitMQ three-node quorum leader loss/election, minority partition behavior, publisher confirm across leadership change, or DLQ/retry topology failover.
- PostgreSQL primary failover, replica promotion, synchronous replication, split brain, transaction ambiguity at every statement, or connection storms.
- Correlated PostgreSQL and RabbitMQ failure, long-duration outage/soak, event-loop stalls near heartbeat tolerance, capacity, or recovery thundering herd.
- Metrics, alerts, operator repair, multi-owner fencing, authentication/authorization, Human Console, or model-driven L3 collaboration.
