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

M9.11 bounds root-Session mutation identities in the database. One policy row supplies retention, global capacity, and cleanup batch size to every Router and direct durable Runtime fallback. New-key cleanup and admission share the placement advisory lock; existing Router-created intents take the shorter owner transaction path. Cleanup requires both elapsed retention and terminal/stale durable work, so age alone cannot erase an active Session replay or an in-flight exact-owner claim. Capacity failure is retryable `BACKPRESSURE` before placement or PTY side effects.

M9.12 separates graceful owner drain from immediate RPC shutdown. The `DRAINING` transition serializes behind earlier placement claims and excludes later placement, giving the daemon a database-authoritative set of unfinished root-create intents for its exact owner incarnation. The daemon keeps RPC available for a bounded settlement window, waits for that count to reach zero, then stops new socket admission and drains accepted responses within the same deadline before closing Sessions and persisting `STOPPED`. Deadline expiry never reassigns an exact-owner intent: the request remains unfinished for later retention handling, while ambiguous in-flight writes keep their existing uncertainty contract.

M9.13 composes that boundary across repeated owner replacement without adding a new transaction. Each uniquely keyed root create still commits one placement intent and one Session binding; `DRAINING` still excludes later claims; and a boot-unique replacement updates only the stable owner's registry incarnation/epoch before admitting new work. The cross-round audit treats distinct request-to-Session bindings and zero unfinished intents as the durable invariant, not equal placement counts while availability changes.

M9.14 makes owner expiry itself a transaction precondition. Ordinary heartbeat, drain, and stop updates require `lease_expires_at > now()` in the same SQL statement that matches exact owner ID, instance, and epoch. A delayed process cannot first revive routing and only later discover expired Session fences. Same-process re-registration remains a separate recovery transaction: it can retain the registry epoch only if no replacement won, but readiness returns only after old live generations reconcile to `BROKEN/UNKNOWN` and their Session leases release.

M9.15 keeps the same placement transaction and changes only its deterministic ordering. Under the global placement advisory lock, PostgreSQL selects the unexpired ACTIVE row with the smallest exact numeric `placement_count / capacity_weight` ratio and stable owner-ID tie break, then increments count/version atomically. Weight is persisted registry configuration, not a lease or hard admission limit; failed forwarding still consumes the claimed attempt and stable-owner history survives replacement.

M9.16 keeps PostgreSQL primary authority outside iTerminal while allowing every durable adapter to follow an externally promoted primary through an ordered endpoint list. A pool admits only a server that is out of recovery and read-write. Infrastructure, read-only, shutdown, or timeout failure retires the exact connection and advances the next supervisor attempt; it never replays the failed SQL or transaction across endpoints. Runtime recovery still destroys old PTYs and commits `BROKEN/UNKNOWN` reconciliation before readiness, while Router recovery still fails before owner forwarding.

M9.17 bounds the database half of remote owner reclamation. Runtime durability and owner-registry pools set `idle_in_transaction_session_timeout` to no more than the host-local Guardian watchdog budget. If a Runtime freezes after `BEGIN` while holding an owner/Session row lock, PostgreSQL terminates that idle backend before a replacement must recover; the abandoned transaction rolls back rather than being replayed. The Guardian independently freezes and kills the old PTY process set. These two cleanup mechanisms preserve separate database and kernel truth and neither one marks an ambiguous Shell effect successful.

M9.18 also bounds connection cardinality before a transaction starts. One durable Runtime owns four logical database roles (durability, admission, observation, and owner registry); each role uses at most `ITERM_DATABASE_POOL_MAX` connections per configured endpoint, default 2. Waiting on a saturated local pool does not acquire a database lock or change durable truth, and existing connect/query/statement deadlines still fail closed. Operators must budget Router, queue, Console, migration, monitoring, and administrative clients separately.
