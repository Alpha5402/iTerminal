# ADR-0058: Bounded normalized-fact retention and database capacity signal

- Status: Accepted for M10.12
- Date: 2026-08-31
- Refines: ADR-0003, ADR-0010, ADR-0016, ADR-0041, ADR-0051, ADR-0053

## Context

Artifact content and Event history already have PostgreSQL-authoritative budgets and bounded cleanup.
Other durable facts still grow with accepted work: Approvals, Actions/Executions/Sensitive Inputs,
published Outbox rows, and completed Consumer Inbox rows. Deleting those rows only by age would be
unsafe:

- an active or pending Outbox row is the recovery source for work not known to be published;
- an active Inbox lease and its completed record protect at-least-once delivery;
- an Approval may still authorize one exact Agent Execute;
- an Action idempotency key may still be the only durable proof that a Shell-affecting request was
  already accepted;
- Events, Artifacts, Snapshots, or Approvals can still reference an Action or Execution.

PostgreSQL also has no portable per-database hard disk quota. Logical payload counters do not include
indexes, tuple headers, free space, or MVCC bloat, while `pg_database_size` is an observation rather
than an atomic admission reservation. Treating either as an exact whole-database limit would create a
false safety claim.

## Decision

### Retention policy and maintenance transaction

One singleton `durable_fact_retention_policies` row defines a 30-day default maximum age and a
per-table cleanup batch of 1,000 rows. `pnpm facts:maintain` applies migrations and performs one
serialized transaction. It locks the policy row and deletes at most one batch from each fact class in
dependency order. Concurrent invocations use row locks and `SKIP LOCKED`; they never race an active
fact mutation into eligibility.

The command emits only aggregate counts and policy timestamps. It does not print commands, request
payloads, Actor principals, paths, broker payloads, or database endpoints.

### Approval eligibility

An Approval is eligible only after its effective terminal time is older than the cutoff:

- `DENIED`, `EXPIRED`, or `CONSUMED`; or
- `PENDING`/`APPROVED` whose database expiry is already older than the cutoff and therefore cannot
  authorize an Execute.

Deleting an Approval removes its bounded-history/idempotency window. A later proposal may reuse the
request key as a new Approval, but it still requires the current generation, exact request hash, and
the configured Human decision policy. Retained Approval Events remain ordinary Event-history facts
until Event retention removes them.

### Outbox and Inbox eligibility

- Only an Outbox row with committed `published_at` older than the cutoff is eligible. Pending,
  claimed, failed, or confirm-ambiguous rows remain pinned regardless of age.
- Only a `COMPLETED` Inbox row older than the cutoff is eligible, and only after no Outbox row with
  the same message ID remains. `PENDING` and `PROCESSING` rows remain pinned.

A broker redelivery after both retention windows does not replay Shell input. The Worker creates a
fresh Inbox attempt and must inspect the current PostgreSQL Execution/Session tuple before dispatch;
a completed, stale, or deleted Execution is `STALE`/`INVALID` and receives no PTY write. This does not
replace Inbox deduplication inside the retained window.

### Action-family eligibility

An Action is eligible only when all of these predicates hold in the deleting transaction:

1. its status is `COMPLETED`, `FAILED`, `INTERRUPTED`, or `UNKNOWN` and `updated_at` is older than the
   cutoff;
2. its generation is no longer current, or the Session is `BROKEN`/`CLOSED`;
3. no Session names its Execution as active;
4. no Event, Artifact, Snapshot, Approval, or Outbox still references the Action/Execution.

Deleting an eligible Action cascades its Execution and Sensitive Input lifecycle row. It does not
delete Actors, Sessions, Generations, Snapshots, Checkpoints, Events, Artifacts, or watermarks.
Because a retained current live generation is never eligible, expiry of an Action idempotency row
cannot turn the same target into a second live PTY side effect.

### Whole-database capacity signal

One singleton `database_capacity_policies` row defaults to a 10 GiB critical threshold and an 80%
warning threshold. `pnpm capacity:inspect` reads `pg_database_size(current_database())`, returns
bounded aggregate metadata, and classifies the sample as `HEALTHY`, `WARNING`, or `CRITICAL`.
`CRITICAL` exits with status 2 so a scheduler or monitoring system can alert.

This is an operator signal, not an admission reservation. It never chooses facts to delete and never
runs VACUUM, rewrites a table, changes retention policy, or terminates a Runtime. A production hard
stop still requires an externally provisioned volume/tablespace quota plus headroom for PostgreSQL,
WAL, maintenance, and failure recovery.

## Consequences

- Normalized work facts now have an explicit, bounded cleanup path without weakening live PTY,
  unknown-delivery, Approval, or retained-window idempotency semantics.
- Cleanup may report zero while old rows remain pinned by Events, Artifacts, Snapshots, pending
  delivery, or a live generation. Operators must run the corresponding maintenance or resolve the
  live dependency; this command does not force deletion.
- The database-size command can drive alerts from real PostgreSQL allocation, including indexes and
  bloat, but its sample can change immediately after the transaction.
- Actors and Session lineage remain durable identity/history anchors and still require a separate
  lifecycle/export/legal-hold decision before deletion.

## Rejected alternatives

- **Delete every row older than a timestamp:** can reopen live Action idempotency or lose pending
  delivery recovery.
- **Delete Inbox rows while the corresponding Outbox fact remains:** weakens the retained
  at-least-once deduplication window before the producer fact is settled.
- **Cascade Sessions to reclaim everything:** destroys lineage, checkpoints, current routing truth,
  and retained audit evidence as one opaque side effect.
- **Use `pg_database_size` as an exact transaction quota:** concurrent writes, indexes, and MVCC make
  the sample unsuitable as a reservation ledger.
- **Automatically delete on CRITICAL:** capacity pressure is not authority to discard audit or
  recovery facts.

## Not covered

- Actor/Session/Generation lifecycle deletion, recording/export/legal hold, immutable audit export,
  or restore testing.
- Filesystem/tablespace quotas, WAL/archive capacity, autovacuum tuning, physical compaction, remote
  alert delivery, or multi-database aggregation.
- A guarantee that 30 days is suitable for a jurisdiction, organization, broker retention policy,
  or incident-response requirement; operators must set policy before production use.
