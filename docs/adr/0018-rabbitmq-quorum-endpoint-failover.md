# ADR-0018: Quorum recovery requires broker election and client endpoint failover

- Status: Accepted for M8.9
- Date: 2026-08-30

## Context

A quorum queue can elect a replacement leader only when a majority of replicas remains available. That server-side guarantee is insufficient if the Outbox relay and Execution Worker know only the failed node's address. Existing reconnect supervision repeatedly opens the same URL, so a healthy two-node majority would remain unreachable from the application after its configured endpoint stops.

The M8.5 single-node restart test proves reconnect to one returning broker. M8.8 proves heartbeat detection under silent loss. Neither proves three-node quorum replication, leader election, or application progress while the original leader remains down.

## Decision

### Cluster and topology

- M8.9 verification uses an isolated three-node RabbitMQ cluster with one shared Erlang cookie and persistent node identities.
- Runtime exchange, main queue, retry queue, and DLQ retain durable declarations; all three queues use RabbitMQ quorum queue type.
- The test discovers the actual main-queue leader from RabbitMQ state and stops that node. It does not assume that the first endpoint is always leader.

### Client endpoints

- Supervised RabbitMQ publishers and consumers accept an ordered, non-empty list of broker URLs. A single URL remains backward compatible.
- Each new connection attempt advances through endpoints round-robin. Connection state exposes only the endpoint index, never credentials or URL text.
- Heartbeat, capped jittered reconnect, publisher confirm, manual ACK, retry exchange, and Inbox behavior are unchanged on every endpoint.
- Configuration may provide `ITERM_RABBITMQ_URLS` as a comma-separated endpoint list. `ITERM_RABBITMQ_URL` remains the single-endpoint fallback.

### Failure and recovery semantics

- Stopping the actual queue leader must cause a majority election while that node remains down. Relay and Worker reconnect through surviving endpoint(s) and continue processing.
- Publisher-confirm ambiguity across leader loss remains at-least-once. A message may be published again if the prior confirm/Outbox mark boundary is unknown.
- Consumer redelivery after leader loss must reacquire the durable Inbox and re-inspect current Execution state. No reconnect path directly replays a Shell command.
- The recovered node may rejoin after application progress is proven; bringing it back is cleanup, not the success condition.

## Consequences

- The queue plane can make progress through one broker/leader failure when a two-node majority and at least one configured endpoint remain reachable.
- Endpoint ordering is a local availability mechanism, not service discovery, load balancing, or owner routing.
- Duplicate deliveries and publish attempts remain observable and expected; exactly-once is still not claimed.
- This slice does not prove minority partitions, pause-minority behavior, simultaneous node failures, cross-zone latency, rolling upgrades, schema compatibility, correlated PostgreSQL failure, or long-duration soak.
