# ADR-0014: Supervise RabbitMQ connections without replaying ambiguous effects

- Status: Accepted for M8.5
- Date: 2026-08-30

## Context

The M8.1 publisher and consumer establish one AMQP connection at process startup. A broker restart closes that connection permanently: the Outbox relay keeps retrying through an unusable publisher, while the Execution Worker remains alive without a consumer. Process supervision alone cannot distinguish that silent half-alive state.

Reconnect must preserve the existing crash contract. A publisher connection may fail after RabbitMQ accepted a message but before its confirm reached the client. A consumer connection may fail with unacknowledged deliveries in flight. Retrying either transport operation as if nothing happened would turn uncertain delivery into an exactly-once claim the system cannot make.

## Decision

### Publisher

- The standalone Outbox relay uses a reconnecting publisher wrapper.
- It lazily establishes one underlying confirm connection and serializes connection attempts.
- A connect or publish failure invalidates and closes that connection. The failed `publish` call still rejects; the Outbox relay releases its database claim and schedules the existing durable retry.
- The wrapper never retries the same `publish` call internally. A later Outbox claim may publish the stable message ID again, and Consumer Inbox remains the duplicate boundary.
- Reconnect attempts use capped exponential backoff with jitter. During the cooldown, calls fail promptly instead of opening one connection per claimed row.

### Consumer

- The Execution Worker owns a background consumer supervisor rather than a one-shot consumer.
- Connection or channel close tears down the complete consumer generation. The supervisor waits with capped exponential backoff and jitter, then declares topology and starts a new consumer.
- RabbitMQ requeues unacknowledged deliveries when the old connection closes. The new consumer re-runs Consumer Inbox acquisition and PostgreSQL state inspection before any owner-local dispatch.
- Worker shutdown aborts reconnect delay, closes the active consumer, and waits for the supervisor loop. A Worker may start while RabbitMQ is unavailable; this is degraded availability, not false readiness.

### PostgreSQL outage

- PostgreSQL remains the durable truth and is not hidden behind an in-memory retry queue.
- A failed admission does not write the PTY. Once a durability call has failed, the affected live generation remains `BROKEN` even if the Pool reconnects; it is never silently revived.
- M8.5 does not add a PostgreSQL loop supervisor. A database process outage may still terminate the standalone relay or leave owner-wide reconciliation pending; that behavior remains a separate M8 slice.

## Consequences

- Broker restart no longer requires restarting relay or Worker processes.
- Reconnect restores availability but does not erase delivery ambiguity; duplicate messages remain expected.
- Backoff bounds connection storms, and consumer prefetch/Outbox capacity continue to bound work.
- Connection state should be exposed through process diagnostics now and health endpoints in the later operator surface.
- A single-node broker restart can prove process-level reconnect locally. Multi-node network partitions, quorum leader failover, alarm behavior, and long-duration soak still require dedicated L4 infrastructure.
