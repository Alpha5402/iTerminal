# ADR-0017: Transport liveness must be bounded under silent network loss

- Status: Accepted for M8.8
- Date: 2026-08-30

## Context

Stopping a PostgreSQL or RabbitMQ process produces TCP close/reset signals and proves process restart recovery, but it does not prove behavior during a silent network partition. A blackholed established socket can remain open indefinitely unless the application protocol or client imposes a liveness deadline.

`amqplib` uses its socket `timeout` only while opening the connection and disables it after the AMQP handshake. It then relies on the negotiated heartbeat; without an explicit client preference the broker default may make failure detection too slow for local Runtime recovery. `node-postgres` has separate connection and query read deadlines. A blackholed `SELECT 1` returns `Query read timeout` without a SQLSTATE, so classification based only on PostgreSQL error codes is insufficient.

## Decision

### RabbitMQ liveness

- Every iTerminal RabbitMQ publisher and consumer requests a heartbeat interval of five seconds by default. An explicit positive configuration or `heartbeat` URL query may tune it.
- A connection is considered unavailable only when the AMQP library reports heartbeat/socket/channel failure. Heartbeat loss invalidates transport state; it does not decide whether a previously published message reached the broker.
- Reconnection continues to use capped jittered backoff. Outbox lease and Consumer Inbox semantics remain the only duplicate/loss boundaries.

### PostgreSQL liveness

- Runtime database operations retain their existing statement/query timeout. Messaging repositories expose a separate bounded operation timeout in addition to connection timeout; defaults remain conservative for production and tests may lower them for deterministic fault injection.
- `Query read timeout`, connection-checkout timeout, and explicit connection termination are availability failures for the supervised messaging loops. Unexpected schema/domain/programming errors remain fatal.
- Runtime database timeout still opens the owner safety circuit when durable truth cannot be reached. Recovery must reconcile old PTYs before readiness, exactly as ADR-0015 requires.

### Fault model and recovery

- Verification uses a local TCP fault proxy between clients and the real PostgreSQL/RabbitMQ containers. `BLACKHOLE` mode keeps both TCP endpoints open while discarding bytes in both directions; it does not send FIN/RST or stop either server process.
- Detection deadlines are measured from blackhole activation to a surfaced unavailable state. Recovery is measured after forwarding resumes and replacement protocol connections are usable.
- No Action, command, Input, or Control is retried merely because transport liveness returns. Pending Outbox work may publish again, and Inbox/current-Execution validation prevents duplicate PTY dispatch.

## Consequences

- Silent RabbitMQ loss is detected in a bounded number of negotiated heartbeat intervals instead of depending on operating-system TCP timeouts.
- PostgreSQL blackholes fail bounded health/business queries instead of hanging loop shutdown and readiness indefinitely.
- More frequent heartbeats add small steady-state traffic and require event-loop stalls shorter than the configured tolerance.
- A local byte-drop proxy proves single-host transport behavior, not router/firewall diversity, asymmetric multi-hop partitions, RabbitMQ quorum leader failover, PostgreSQL primary failover, or long-duration soak. Those remain L4 work.
