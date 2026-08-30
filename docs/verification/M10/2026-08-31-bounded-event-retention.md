# M10.7 bounded cursor-safe Event retention verification

**Result: PASS at L2 for PostgreSQL-authoritative bounded Event-prefix cleanup, durable deletion
watermarks, explicit stale-cursor resynchronization, and the metadata-only operator path.**

Date: 2026-08-31

Platform: macOS arm64, Node.js 22+, pnpm 10.33.2, PostgreSQL 17 Alpine in a disposable local Docker
container

## Scope

- Apply migrations 001 through 018 to a freshly created PostgreSQL database.
- Delete at most one configured batch from one Session generation per maintenance invocation.
- Enforce the per-generation Event count through repeated bounded passes.
- Delete only the consecutive expired prefix when Event observation times are non-monotonic.
- Preserve the latest Event as an anchor even when every Event is expired.
- Persist the deleted-through watermark and reject a nonzero cursor below it.
- Let a fresh query start from the retained suffix without renumbering Events.
- Preserve Session-generation delete/truncate lifecycle behavior.
- Exercise the supported `retention:maintain` command and inspect its metadata-only output.

## Commands and results

The disposable database was dropped and recreated before this run. No earlier schema or rows were
retained.

```sh
ITERM_DATABASE_URL=postgresql://iterminal:***@127.0.0.1:<port>/iterminal_test \
  pnpm test:m10:retention
```

Result: 2 files and 18 PostgreSQL integration tests passed. The new cases inserted ten Events under
a five-Event policy and a two-row batch, then observed deletion results `2, 2, 1, 0`, retained exact
sequences `6..10`, and a watermark of sequence 5 with five deleted rows. A stale `after=1` query
failed with `RESYNC_REQUIRED` and `minimumAvailableSequence=3` after the first pass.

The age case inserted timestamps `old, old, fresh, old, old`. One pass removed only sequences 1 and
2, retaining `3,4,5`; it did not create a hole by deleting the later old rows. A separate all-old
generation retained only its latest sequence 3 anchor.

An unsupported direct deletion of sequence 4 from `1..6` advanced the safe floor to 5. A stale
`after=3` query required resynchronization, a fresh query returned only `5,6`, and one bounded
maintenance pass physically removed the three conservatively masked older rows.

```sh
ITERM_DATABASE_URL=postgresql://iterminal:***@127.0.0.1:<port>/iterminal_test \
  pnpm retention:maintain
```

Result: the public operator command applied migrations, completed one bounded pass, and printed one
JSON object with `deletedBytes`, `deletedEvents`, and the effective policy. It printed no Event
payload, Event/Session ID, command, hash, or database URL.

```sql
SELECT max(version), count(*) FROM schema_migrations;
```

Result: `18|18` on the fresh database. PostgreSQL also reported all four migration-018 triggers:
Event delete watermark recording, Event truncate recording, generation-delete watermark cleanup,
and generation-truncate watermark cleanup.

A separate upgrade fixture applied migrations 001 through 017, then created three legacy deletion
shapes before applying 018: an internal-hole generation (`1,2,4,6` of allocated `1..6`), a clean
deleted prefix (`3..6` retained), and a missing-tail generation (`1..5` of allocated `1..6`). The
backfilled `(deletedThrough, deletedEvents)` values were respectively `(5,2)`, `(2,2)`, and `(6,1)`.
This proves exact prefix preservation and conservative masking when an older schema already contains
an ambiguous internal or trailing hole.

```sql
SELECT count(*)
  FROM session_events event
  JOIN event_retention_watermarks watermark
    ON watermark.session_id = event.session_id
   AND watermark.session_generation = event.session_generation
 WHERE event.event_sequence <= watermark.deleted_through_sequence;
```

Result: `0` masked physical rows after the supported maintenance path.

```sh
pnpm verify
```

Result: format, lint, typecheck, default test suite, documentation evidence check, TypeScript build,
and Console production build passed. The default suite reported 29 files passed, 32 skipped, 112
tests passed, and 99 skipped. PostgreSQL-dependent tests are separately evidenced above. The Vite
build retained its existing advisory warning for a minified chunk larger than 500 kB; the build
completed successfully.

## Failure found during verification

The first bounded-prefix test deleted sequences 1 and 10 instead of 1 and 2. The selection query
cast `event_sequence` to text and reused that output name; PostgreSQL resolved `ORDER BY
event_sequence` to the text alias, producing lexicographic order `1,10,2,...`. The query now orders
explicitly by the numeric source column `event.event_sequence`. The test retains the exact sequence
assertion so this regression cannot pass on deletion count alone.

An earlier migration draft attached a foreign key from the watermark to the generation. PostgreSQL
fired the Event cascade-delete statement trigger while the parent generation still existed but was
already being removed, causing watermark insertion to violate the cascade lifecycle. Migration 018
instead ignores nested cascade deletes and uses explicit generation delete/truncate triggers to
remove lifecycle metadata. The existing Session lifecycle tests pass on the fresh schema.

## Not proven

- Action, Execution, Approval, Outbox, Inbox, Snapshot, Checkpoint, or rate-limit retention.
- Whole-database byte/disk/WAL/backup bounds, vacuum behavior after a production-size deletion, or
  filesystem capacity alerts.
- An always-on scheduler, multi-day cleanup soak, high-cardinality concurrent writers, or hostile
  direct SQL deletion beyond the trigger-level conservative watermark behavior.
- Artifact/recording export, legal hold, archive tier, secure erase, or per-tenant policy.
- Browser/MCP L3 cursor-resync UX. This report proves the PostgreSQL repository contract and operator
  path at L2, not an end-user Timeline recovery workflow.
