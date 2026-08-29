# ADR-0009: Transactional Outbox, RabbitMQ wake-ups, and Consumer Inbox

- Status: Accepted for M8.1
- Date: 2026-08-30

## Context

Execute admission already writes an `ExecutionReady` Outbox row in the same PostgreSQL transaction as Session reservation, Action, Execution, and accepted Event. Until M8.1, nothing claimed or published that row. Publishing directly inside the admission transaction would couple database availability to broker availability and would still leave an ambiguous crash window.

RabbitMQ also cannot become the source of Action ordering or PTY ownership. A delayed or duplicated message may describe an Execution that is already RUNNING, terminal, or UNKNOWN. Acting on message order alone could write a command twice or create a second PTY owner.

RabbitMQ documents publisher confirms and consumer acknowledgements as separate safety mechanisms: confirms cover publisher-to-broker transfer, while acknowledgements cover broker-to-consumer processing. Both are required for this path. Manual acknowledgements should be combined with bounded prefetch to avoid unbounded in-flight deliveries. See the official [acknowledgement and confirms guide](https://www.rabbitmq.com/docs/confirms) and [dead-letter exchange guide](https://www.rabbitmq.com/docs/dlx).

## Decision

M8.1 introduces a reliable notification plane without changing the live Execute arbitration:

```text
PostgreSQL admission transaction
        |
        +-- Action + Execution + Event + Outbox
                                      |
                              lease-based relay loop
                                      |
                           publisher-confirmed RabbitMQ
                                      |
                         manual-ack consumer + Inbox
                                      |
                     reload current Execution/Session from DB
```

### Outbox relay

- Publishers claim pending rows with `FOR UPDATE SKIP LOCKED`, a bounded batch, a publisher ID, a claim token, and an expiring lease.
- A RabbitMQ confirm is required before the row is marked published.
- Marking published also appends `outbox.published` to the Session Event stream in the same PostgreSQL transaction.
- Broker or publish failure releases the claim with bounded exponential retry metadata. A crashed publisher leaves its lease to expire.
- A crash after broker confirm but before PostgreSQL mark intentionally causes a duplicate publish. The system provides at-least-once notification, not exactly-once delivery.
- `apps/outbox-relay` is an independently supervised loop. `SIGINT`/`SIGTERM` stops new polling, waits for the current batch, then closes RabbitMQ and PostgreSQL.

### RabbitMQ topology

- `ExecutionReady` uses a durable direct exchange and durable quorum queue.
- Messages are persistent and carry a stable Outbox ID as AMQP `messageId`.
- Publishers use a confirm channel, mandatory routing, and wait for both broker confirmation and connection backpressure.
- Consumers use manual ACK and bounded prefetch.
- Transient processing failure is republished with confirmation to a fixed-delay retry queue, then the original delivery is ACKed. If retry publish fails, the original is NACKed with requeue.
- Invalid or exhausted messages are rejected without requeue and routed to a durable DLQ.

The retry queue avoids an immediate hot requeue loop. Production operators may move dead-letter arguments to RabbitMQ policies; the repository declares them directly so local and CI fixtures are self-contained.

### Consumer Inbox and database recheck

- Inbox identity is `(consumer_id, message_id)` plus a canonical payload hash.
- A PROCESSING row has a lease token and expiry. Concurrent duplicates are retried; completed duplicates are ACKed without invoking the handler.
- Reusing one message ID with different content is corruption and goes to the DLQ.
- Before invoking an owner/router handler, the consumer reloads Execution and Session from PostgreSQL.
- Only `Execution=DISPATCHING`, `Session=RESERVED`, matching Session/generation/active Execution is READY. Terminal, RUNNING, BROKEN, or otherwise delayed messages are completed as `IGNORED_STALE` and ACKed. Missing or identity-mismatched state is invalid.
- Handler failures are retried up to a bounded persisted Inbox attempt count, then dead-lettered.

### Current dispatch boundary

M8.1 does **not** let the RabbitMQ consumer write to a PTY. The M4.1 modular daemon still performs owner-local dispatch immediately after durable admission. The notification plane and injected handler are now proven independently, but moving the actual write behind the wake-up requires the M8.2 owner-local dispatch loop and its pre/post-write crash matrix. This prevents a partial queue implementation from creating duplicate Shell input.

## Consequences

- PostgreSQL and RabbitMQ outages are decoupled at admission: committed Outbox work remains recoverable.
- Duplicate publication is expected and harmless at the Consumer Inbox boundary.
- Message ordering cannot override current PostgreSQL state.
- The standalone relay can scale horizontally because claims are leased and skip locked.
- Queue names are configurable by prefix for isolation; M9 still owns multi-worker Session routing and fencing.
- Full Execute/Input crash semantics, owner routing, RabbitMQ reconnect supervision, long outage soak, and production topology policy remain unproven.
