# Event retention operations

M10.7 bounds the durable Event observation timeline by age and per-generation count. It does not
delete normalized Action, Execution, Approval, Snapshot, or Checkpoint facts, and it does not impose
a whole-database byte limit.

## Defaults and invariants

Migration 018 extends the database-authoritative `retention_policies.default` policy:

| Setting                     |        Default | Meaning                                                  |
| --------------------------- | -------------: | -------------------------------------------------------- |
| `max_age_days`              |         7 days | Maximum age of the removable contiguous Event prefix     |
| `max_events_per_generation` | 100,000 Events | Maximum retained Events per Session generation           |
| `cleanup_batch_size`        |    10,000 rows | Maximum Event rows removed by one maintenance invocation |

Maintenance deletes only a numeric-sequence prefix, preserves the latest Event as an anchor, and
advances `event_retention_watermarks`. Do not update the watermark by hand. A direct SQL delete is
tracked by a database trigger and can conservatively mask every earlier sequence to prevent a
silent cursor hole.

Active generations are deliberately eligible. Retention does not stop the PTY or change Session,
Action, or Execution state, but clients reading an old cursor may receive `RESYNC_REQUIRED` with a
`minimumAvailableSequence`.

## Inspect without reading Event payloads

```sql
SELECT max_age_days,
       max_events_per_generation,
       cleanup_batch_size,
       updated_at
  FROM retention_policies
 WHERE scope = 'default';

SELECT count(*) AS generation_count,
       coalesce(sum(deleted_events), 0) AS deleted_events,
       max(updated_at) AS last_retention_at
  FROM event_retention_watermarks;
```

To find generations currently above the count target without selecting payloads:

```sql
SELECT event.session_id,
       event.session_generation,
       count(*) AS retained_events
  FROM session_events event
 GROUP BY event.session_id, event.session_generation
HAVING count(*) > (
  SELECT max_events_per_generation
    FROM retention_policies
   WHERE scope = 'default'
)
 ORDER BY retained_events DESC;
```

## Run one bounded maintenance pass

```sh
ITERM_DATABASE_URL=postgresql://... pnpm retention:maintain
```

For an ordered writable-primary endpoint list, use `ITERM_DATABASE_URLS`. The command applies
pending migrations, handles at most one generation, deletes at most one configured batch, and
prints a single JSON object containing the policy plus `deletedEvents` and `deletedBytes`. It never
prints Event content, Session IDs, Event IDs, commands, or credentials.

Repeat until `deletedEvents` is `0` when draining a backlog. Concurrent commands serialize through
the policy lock. Event ingestion does not take that global lock; the selected generation may pause
briefly while its prefix is locked and removed.

## Change policy

Use one transaction. Existing constraints require positive maximums and a cleanup batch from 1 to
100,000 rows.

```sql
BEGIN;
UPDATE retention_policies
   SET max_age_days = 14,
       max_events_per_generation = 200000,
       cleanup_batch_size = 10000,
       updated_at = now()
 WHERE scope = 'default';
COMMIT;
```

Reducing a limit does not synchronously delete the backlog. Schedule repeated bounded maintenance
passes. Do not run an ad-hoc predicate delete to imitate age cleanup: caller-provided Event times can
be non-monotonic, so deleting every individually old row can move the safe cursor floor farther than
expected.

## Cursor recovery

When a Timeline consumer receives `RESYNC_REQUIRED`:

1. discard its old cursor and any assumption that the missing prefix is complete;
2. issue a fresh query with no cursor and no nonzero `after` value;
3. rebuild the consumer's bounded projection from the returned retained suffix;
4. continue from the new cursor.

Do not retry the stale cursor in a loop. Event retention is intentional history loss within the
observation projection, not a transient transport error.

## Integrity checks

The supported maintenance path should leave no physical Event at or below its watermark:

```sql
SELECT count(*) AS masked_rows
  FROM session_events event
  JOIN event_retention_watermarks watermark
    ON watermark.session_id = event.session_id
   AND watermark.session_generation = event.session_generation
 WHERE event.event_sequence <= watermark.deleted_through_sequence;
```

A nonzero result can occur after unsupported direct middle deletion. Repeated
`pnpm retention:maintain` invocations remove those masked rows in bounded batches.

## Rollback boundary

Migration 018 is forward-only during normal operation. Before running an older binary, stop Event
writers and maintenance, take a verified backup, and understand that the older query path does not
consult the watermark. Removing migration 018 protection or serving old readers concurrently can
silently skip retained history and is unsupported.

## Still required outside M10.7

- Action/Execution/Approval/Outbox/Inbox and other normalized-fact retention.
- Artifact/recording export, legal hold, secure erase, and archive policy.
- Whole-database/filesystem capacity alarms, vacuum/WAL/backup policy, disk-full drills, and an
  always-on scheduler.
