# ADR-0012: Back off before requeue when retry publication fails

- Status: Accepted for M8.3
- Date: 2026-08-30

## Context

The Execution Worker normally handles a transient delivery failure by publishing the original message to a TTL retry queue with publisher confirmation, then ACKing the original delivery. If that retry publication fails, ACKing would lose the wake-up, while dead-lettering immediately would turn a transport outage into a permanent business failure.

The remaining safe RabbitMQ disposition is `NACK(requeue=true)`. Doing it immediately while the retry exchange/channel remains unavailable can create a hot redelivery loop.

## Decision

- Retry publication must still be publisher-confirmed before the original delivery is ACKed.
- If retry publication fails, the consumer waits an explicit backoff before NACKing the original delivery with requeue.
- The default backoff equals the configured retry-queue TTL and is never less than one millisecond.
- Consumer prefetch remains the hard bound on simultaneous failed deliveries. Operators may configure a longer backoff without changing message semantics.
- The Inbox lease/release cycle remains authoritative for processing attempts; no handler side effect is considered complete on this path.

This is a rate-limited preservation mechanism, not reconnect supervision. A permanently closed retry confirm channel still requires process supervision/restart. The backoff prevents a tight loop while retaining the original durable message for that recovery.

## Consequences

- A temporary retry-publisher outage does not ACK or dead-letter the original message.
- Broker load is bounded by prefetch and the retry-publish failure backoff rather than CPU/network speed.
- Shutdown may wait for one bounded backoff before returning unacked deliveries to RabbitMQ.
- Automatic AMQP channel recreation, partition handling, quorum leader failover, jittered exponential backoff, and long-outage alarms remain release-hardening work.
