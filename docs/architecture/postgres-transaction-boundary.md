# PostgreSQL transaction boundary

M2 makes PostgreSQL the durable acceptance boundary for ExecuteAction. Live PTY state is still owned by the single-process Executor; durable acceptance is represented by one database transaction.

## `acceptExecute` transaction

The repository performs these operations under one transaction:

1. Resolve `(session, actor, idempotency_key)` before attempting a new reservation.
2. Return the original Action/Execution when the request hash matches; reject changed hashes.
3. Serialize new admissions with a transaction advisory lock and reject retryably before reservation when unpublished Outbox capacity is exhausted.
4. CAS `sessions.status` from READY to RESERVED and assign the active Execution.
5. Allocate the next Session Action sequence.
6. Upsert Actor identity.
7. Insert immutable ExecuteAction payload and DISPATCHING Execution.
8. Allocate the generation-scoped Event sequence and insert `action.accepted`.
9. Insert an `ExecutionReady` Outbox record.
10. Mark the generation RESERVED and commit.

There is no in-Session Execute queue. A failed CAS returns structured `PTY_BUSY`; a pre-commit error rolls back every row above.

## Crash semantics

On Runtime startup, the new owner calls `recoverLostOwner` for any owner identity that no longer has a live process boundary. The transaction:

- changes STARTING/READY/RESERVED/RUNNING Sessions and generations to BROKEN;
- clears the active Execution pointer;
- changes DISPATCHING/RUNNING Executions and Actions to UNKNOWN;
- appends a generation-scoped `session.broken` Event.

It never creates a replacement PTY under the old generation. Rebuild remains a separate future Action with a new generation.

## Projection writes

Snapshots and Shell Checkpoints use observed-time conditional upserts. An older observation cannot overwrite a newer one. PTY output chunks allocate Event sequence numbers transactionally. The initial retention policy keeps seven days or 100,000 Events per generation, whichever limit removes data first; operators can lower these values for constrained environments.

## Current boundary

M4.1 integrates this transaction with the live daemon while keeping PTY callbacks on a bounded asynchronous ingest loop. M8.1 adds leased Outbox publication, RabbitMQ confirms, and Consumer Inbox deduplication. M8.2 preserves the same fail-fast Session reservation while an `ExecutionReady` wake-up drives an owner-local Unix RPC and PTY dispatch; a durable write-attempt boundary prevents blind replay after owner loss.

M8.3 applies the same conservative boundary to Input/Control: an expected owner/generation/active-Execution transaction appends `interaction.write_attempted` before the adapter call. `DELIVERED` is a later transaction. Owner loss between them leaves the Action `UNKNOWN`; it is not replayed against a replacement PTY.

M8.4 bounds unpublished Outbox work before reservation. Capacity rejection is `BACKPRESSURE`, so Application rolls back only its tentative local sequence/reservation and preserves the READY PTY. Database timeout remains `RUNTIME_UNAVAILABLE` and breaks the generation because durable ordering can no longer be guaranteed.

M8.6 distinguishes a Session-scoped statement timeout/conflict from a connection-level PostgreSQL outage. Connection loss opens an owner-wide circuit: every local PTY closes, RPC readiness drops, and a health/recovery supervisor reconnects with bounded backoff. Readiness returns only after `recoverOwner` atomically marks every old live durable generation `BROKEN` and active Execution `UNKNOWN`; no old PTY is recreated.

M8.7 applies a separate availability policy to standalone messaging loops. The Outbox relay pauses claims while PostgreSQL is disconnected; the Execution Worker closes its RabbitMQ consumer generation until the Inbox/inspection repository reconnects and migrates. A broker-confirmed message whose `published_at` commit is unknown remains lease-retryable, so publication is still at-least-once and duplicate safety remains the responsibility of Inbox identity plus current Execution inspection.

M8.8 makes silent socket loss observable: Runtime durability queries and messaging repository operations have client-side read deadlines, while RabbitMQ connections negotiate an explicit heartbeat. A timeout opens the relevant owner/loop circuit but never proves an in-flight transaction or publish outcome; reconciliation, leases, Inbox identity, and current Execution inspection still decide recovery.

M8.9 separates broker availability from queue leadership. Relay and Worker supervisors rotate through an ordered non-empty endpoint list after connection failure; the observed endpoint index is diagnostic only and never becomes durable ownership truth. RabbitMQ may elect a replacement quorum leader, but Outbox leases, publisher confirms, Consumer Inbox identity, and current PostgreSQL Execution state still define safe application progress and duplicate handling.
