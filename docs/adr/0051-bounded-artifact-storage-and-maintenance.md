# ADR-0051: Bounded PostgreSQL Artifact storage and explicit maintenance

- Status: Accepted for M10.5
- Date: 2026-08-31

## Context

Large PTY output is moved from inline Event payloads into PostgreSQL `artifacts`. Reads are bounded
to 64 KiB and each row has a seven-day expiry timestamp, but those controls do not bound storage:
expired rows are not deleted, concurrent writers do not share a byte budget, and operators have no
supported usage or cleanup command. An output-heavy Session can therefore grow the database even
though Runtime memory, durable-ingest queues, Event pages, and artifact reads are individually
bounded.

Silently dropping output at the storage boundary would make the Event timeline and Virtual Screen
claim a durable observation that does not exist. Estimating bytes in each Runtime process would
also race across owners and bypass direct repository users. The admission decision must be one
PostgreSQL fact.

## Decision

### Database-authoritative policy and usage

Migration 017 adds one `default` Artifact storage policy:

- aggregate `max_bytes`, default 1 GiB;
- per-row `max_artifact_bytes`, default 16 MiB and never greater than `max_bytes`;
- `retention_milliseconds`, default seven days;
- bounded `cleanup_batch_size`, default 1,000 rows.

A singleton usage row stores exact Artifact row count and logical content bytes. Migration backfills
it from existing rows. PostgreSQL triggers update it for insert, byte-size update, delete, and
cascading Session deletion. The insert/update trigger locks policy and usage, then enforces the
per-row and aggregate limits. Repository prechecks produce the public error, while the trigger is
the defense-in-depth authority for every SQL writer.

The budget counts Artifact `byte_size`, not PostgreSQL heap/index/WAL amplification and not inline
Event, Action, Approval, Snapshot, or Checkpoint storage. It is therefore an Artifact content budget,
not a whole-database disk quota. Operators still need filesystem/database capacity monitoring.

### Admission and failure semantics

When output crosses the inline threshold, one transaction:

1. validates the exact Session fence when required;
2. reads the bounded cleanup batch size and deletes at most that many expired Artifacts using
   database time; delete/truncate triggers acquire the same singleton locks;
3. locks the singleton policy row and then the usage row, preserving that exact order for
   admission, explicit cleanup, direct deletion, cascading deletion, and policy updates;
4. checks the prospective row and aggregate bytes;
5. inserts the Artifact and its referencing Event atomically.

Artifact expiry starts at database admission time. A caller-provided observation timestamp cannot
extend or shorten retention. Concurrent owners serialize only at the Artifact budget row; ordinary
inline Events do not take that lock.

If the row or aggregate budget is still exceeded after bounded cleanup, the cleanup commits but the
Artifact and Event do not. A direct repository caller receives retryable `BACKPRESSURE` with only
component, phase, requested bytes, current usage, and configured limits. No content, hash, Session
command, database URL, or expired Artifact identifier appears in the error.

For live Runtime output, the PTY bytes have already existed and cannot be retried safely. The
durability adapter therefore uses a second metadata-only transaction to mark the generation
`BROKEN`, its active Execution/Action `UNKNOWN`, any active sensitive period `UNKNOWN`, record a
`session.broken` Event, and release the Session lease. It then returns a non-retryable,
Session-scoped `RUNTIME_UNAVAILABLE` to the Application, which closes the local PTY. The Runtime
never continues with an unaudited output gap, and PostgreSQL never remains falsely `RUNNING`.

### Explicit maintenance

`pnpm storage:maintain` reads the configured writable PostgreSQL endpoint, applies migrations, and
performs one bounded cleanup transaction. Its JSON result contains policy, before/after usage, and
deleted row/byte counts only. It is safe to schedule repeatedly and multiple invocations converge
through the same policy/usage lock. It does not export or print Artifact content.

Artifact admission also performs one bounded cleanup pass, so active installations make progress
without a scheduler. An idle database still requires the explicit command (or an external scheduler)
to reclaim expired rows. One run is intentionally bounded; operators repeat it until
`deletedArtifacts` is zero when draining a large backlog.

An Event may retain an expired/deleted `artifactRef`; reads already return not found after expiry.
Cleanup does not rewrite historical Events or renumber cursors.

## Consequences

- Artifact content growth has one cross-owner hard limit and exact logical-byte accounting.
- Cleanup and cascading deletion cannot leave the usage counter permanently inflated.
- A full Artifact budget creates explicit backpressure and may break the affected live generation
  rather than lose durable observation truth.
- Global serialization adds a short critical section only for large-output Artifact admissions and
  maintenance. Inline Event ingestion keeps its existing concurrency.
- Policy changes remain an operator database action in this slice; no Human Console or MCP mutation
  endpoint is added.

## Not covered

- Event/Action/Approval/Outbox/Inbox/rate-limit bucket cleanup or a whole-database byte quota.
- Artifact export, recording export, legal hold, per-tenant quotas, encryption at rest, object-store
  offload, secure erase, backup/WAL retention, or disk-free-space alarms.
- An always-on maintenance service. The explicit command is schedulable but deployment scheduling
  remains operator-owned.

## Rejected alternatives

- **Trust `expires_at` without deletion:** hides expired reads but does not reclaim database space.
- **Per-Runtime counters:** race across owners and reset on restart.
- **Compute `sum(byte_size)` for every insert:** avoids a counter but makes admission cost grow with
  history and still needs serialization.
- **Delete oldest unexpired content when full:** violates the advertised retention contract and can
  destroy evidence without an explicit policy change.
- **Continue with an inline truncation when full:** silently changes a durable observation into an
  incomplete one after the PTY effect already occurred.
