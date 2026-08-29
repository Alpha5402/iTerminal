# PostgreSQL transaction boundary

M2 makes PostgreSQL the durable acceptance boundary for ExecuteAction. Live PTY state is still owned by the single-process Executor; durable acceptance is represented by one database transaction.

## `acceptExecute` transaction

The repository performs these operations under one transaction:

1. Resolve `(session, actor, idempotency_key)` before attempting a new reservation.
2. Return the original Action/Execution when the request hash matches; reject changed hashes.
3. CAS `sessions.status` from READY to RESERVED and assign the active Execution.
4. Allocate the next Session Action sequence.
5. Upsert Actor identity.
6. Insert immutable ExecuteAction payload and DISPATCHING Execution.
7. Allocate the generation-scoped Event sequence and insert `action.accepted`.
8. Insert an `ExecutionReady` Outbox record.
9. Mark the generation RESERVED and commit.

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

M4.1 integrates this transaction with the live daemon while keeping PTY callbacks on a bounded asynchronous ingest loop. M8.1 adds leased Outbox publication, RabbitMQ confirms, and Consumer Inbox deduplication. Actual PTY dispatch is still owner-local after admission; moving it behind an `ExecutionReady` wake-up remains M8.2 work and must preserve the same fail-fast Session reservation.
