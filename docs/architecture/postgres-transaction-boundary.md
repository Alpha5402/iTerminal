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

The M2 adapter and its transaction scenarios are proven independently against PostgreSQL 17. The M1 in-process Runtime still uses MemoryRuntimeStore for its live CLI path. Replacing that port requires an async ingest/dispatch loop so PTY callbacks never block on SQL; this is intentionally not hidden inside a synchronous adapter.
