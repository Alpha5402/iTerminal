# ADR-0053: Bounded cursor-safe Event retention

- Status: Accepted for M10.7
- Date: 2026-08-31

## Context

`session_events` is the durable, ordered observation journal for one Session generation. The schema
has always contained a default maximum age and Event count, but the original cleanup implementation
could delete every matching row in one transaction, applied age and count predicates independently,
and left no durable record of the removed prefix. Those behaviors are unsafe under sustained PTY
output: maintenance latency is unbounded, an age deletion can create a hole in the middle of the
sequence, and a client whose next Event was deleted can receive a later suffix without being told to
resynchronize. If every Event was deleted, the previous minimum-row check could not detect the gap.

Action, Execution, Approval, and other normalized rows remain the durable state and audit facts.
Event retention bounds the observation timeline only; it must not mutate those normalized facts or
pretend PostgreSQL can reconstruct a lost live PTY.

## Decision

### One database-authoritative policy

The singleton `retention_policies.default` row defines:

- maximum Event age, default seven days;
- maximum retained Events per generation, default 100,000;
- cleanup batch size, default 10,000 and bounded from 1 through 100,000.

Maintenance uses PostgreSQL time unless a test supplies an explicit time. It locks the policy, then
selects and locks at most one pressured Session generation. One invocation deletes at most one
configured batch. Multiple operators serialize on the same policy row and repeated invocations
converge.

Ordinary Event admission does not lock the global policy. It continues to serialize sequence
allocation on its own generation row, so maintenance can delay one generation briefly without
turning retention into a cross-generation ingestion lock.

### Delete only a contiguous prefix

Maintenance considers Events in numeric `event_sequence` order and deletes only the oldest
contiguous prefix. Count pressure removes the excess above the configured per-generation maximum.
Age pressure stops at the first non-expired Event even if a later Event has an older caller-supplied
observation timestamp. The two pressures choose the larger eligible prefix, bounded by the batch.

At least the latest allocated Event remains as an anchor. An all-expired or over-limit generation is
therefore reduced to one Event, not zero. Active generations are not pinned: a long-running Shell
must remain bounded too. Retention does not close its PTY, change its state, or renumber later Events.

### Durable deletion watermark and cursor contract

`event_retention_watermarks` stores, per generation, the greatest sequence known to have been
deleted, the cumulative physical Event rows deleted, and an update timestamp. PostgreSQL statement
triggers advance it for direct deletes and truncation as well as the supported maintenance path.
Deleting or truncating a generation removes the corresponding watermark; it is lifecycle metadata,
not an independent retained audit record.

During migration, a previously deleted contiguous prefix is preserved exactly. If legacy data
already contains an internal or trailing hole, migration cannot safely prove a complete older
suffix: it conservatively masks through the last uncertain sequence, retaining only the latest
anchor when that latest sequence still exists. This one-time visibility loss is preferred to
silently presenting incomplete upgraded history as contiguous.

The supported maintenance path advances the watermark by deleting a contiguous prefix. If an
operator or older binary deletes a middle/later Event directly, the trigger conservatively advances
the watermark through that sequence. Earlier physical rows become logically masked, and later
maintenance removes them in bounded batches. This intentionally sacrifices visibility of an older
fragment rather than serving a timeline with a silent hole.

Event queries combine the watermark with the minimum physical sequence:

- a fresh query (`after` absent or zero) starts after the effective deleted prefix and returns the
  retained suffix;
- a nonzero `after`, including one decoded from a cursor, that falls before the prefix fails with
  `RESYNC_REQUIRED` and `minimumAvailableSequence`;
- a cursor at or beyond the prefix remains valid and preserves its existing query fingerprint and
  scope checks.

This is a forward-only cursor contract. Retention never rewrites an old cursor or silently treats a
stale nonzero cursor as fresh.

### Operator boundary

`pnpm retention:maintain` applies migrations and performs one bounded Event-retention transaction
against the configured writable PostgreSQL endpoint. Its JSON result contains only the effective
policy plus aggregate deleted Event and logical payload/search byte counts. It does not print Event
payloads, Session IDs, or deleted row IDs.

Operators schedule repeated invocations and continue until `deletedEvents` is zero when draining a
backlog. A zero result means that invocation found no generation needing work at its database
snapshot; it is not a whole-database disk-capacity assertion.

## Consequences

- Event cardinality converges to the configured per-generation limit without an unbounded delete.
- Cursor consumers receive an explicit resynchronization boundary after retained history moves.
- Every generation, including a currently active one, can lose old Event observations while its
  normalized state and live PTY continue.
- One retained anchor helps current-state inspection but is not a replay or full audit guarantee.
- Payload/search logical bytes are reported for operational evidence, but the policy limits Event
  count and age rather than Event bytes or PostgreSQL heap/index/WAL size.

## Not covered

- Action, Execution, Approval, Outbox, Inbox, rate-limit bucket, Snapshot, or Checkpoint retention.
- Artifact retention, which is governed separately by ADR-0051, or export/recording/legal-hold
  policy.
- Whole-database byte quotas, filesystem free-space alarms, vacuum tuning, backup/WAL retention, or
  secure erasure.
- An always-on scheduler, per-tenant policy, archive tier, or client-specific cursor lease.

## Rejected alternatives

- **Pin active generations:** permits one long-running interactive Shell to grow without bound.
- **Delete every expired row regardless of sequence:** creates middle holes when observation times
  are non-monotonic and makes cursor continuation ambiguous.
- **Infer deletion only from the minimum remaining row:** cannot detect a fully deleted generation
  and loses history after restart or later inserts.
- **Return the retained suffix for every stale cursor:** silently skips observations and makes a slow
  consumer look complete.
- **Take the global retention-policy lock on Event admission:** gives a simple exact count but turns
  all owners and generations into one ingestion critical section.
- **Delete normalized Action/Execution facts with their Events:** confuses a bounded observation
  projection with durable accepted state and audit truth.
