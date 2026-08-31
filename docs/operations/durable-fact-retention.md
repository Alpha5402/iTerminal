# Durable normalized-fact retention operations

M10.12 bounds cleanup of terminal Approval, Action-family, published Outbox, and completed Consumer
Inbox rows. It preserves every fact that can still authorize work, recover uncertain delivery,
deduplicate inside the retention window, describe a live generation, or satisfy a retained foreign
reference.

## Defaults and deletion order

Migration 019 creates one database-authoritative `durable_fact_retention_policies.default` row:

| Setting                  |        Default | Meaning                                             |
| ------------------------ | -------------: | --------------------------------------------------- |
| `retention_milliseconds` |        30 days | Maximum age before a terminal fact becomes eligible |
| `cleanup_batch_size`     | 1,000 per type | Maximum rows deleted from each class in one run     |

One invocation serializes on the policy row and processes:

1. terminal or irrevocably expired Approvals;
2. committed-published Outbox rows;
3. completed Inbox rows whose same-ID Outbox row is gone;
4. terminal Actions from a stale generation or `BROKEN`/`CLOSED` Session, after every retained
   Event, Artifact, Snapshot, Approval, active-Execution, and Outbox reference is absent.

Action deletion cascades only its Execution and Sensitive Input lifecycle row. Actors, Sessions,
Generations, Events, Artifacts, Snapshots, Checkpoints, and Event watermarks are not deleted.

## Run one bounded pass

```sh
ITERM_DATABASE_URL=postgresql://... pnpm facts:maintain
```

For an ordered writable-primary list, use `ITERM_DATABASE_URLS`. The command applies migrations and
prints one JSON object with the policy and four aggregate deletion counts. It never prints IDs,
commands, payloads, Actor identities, paths, grants, or database endpoints.

Repeat until all four deletion counts are zero when draining a backlog. Zero does not prove there
are no old facts: a row can remain pinned by a live generation, pending/ambiguous delivery, or
retained Event/Artifact/Snapshot/Approval evidence. Run Event and Artifact maintenance first when
those references are intentionally past policy.

## Inspect eligibility without payloads

Use aggregate metadata only:

```sql
SELECT retention_milliseconds, cleanup_batch_size, updated_at
  FROM durable_fact_retention_policies
 WHERE scope = 'default';

SELECT
  count(*) FILTER (WHERE published_at IS NULL) AS pending_outbox,
  count(*) FILTER (WHERE published_at IS NOT NULL) AS published_outbox
  FROM outbox;

SELECT status, count(*)
  FROM consumer_inbox
 GROUP BY status
 ORDER BY status;

SELECT status, count(*)
  FROM approvals
 GROUP BY status
 ORDER BY status;
```

Do not use a broad direct `DELETE` to imitate the supported predicates. Age alone is not proof that
a fact is safe to remove.

## Change policy

Use one transaction. Retention must be positive and at most ten years; the batch must be between 1
and 100,000 rows.

```sql
BEGIN;
UPDATE durable_fact_retention_policies
   SET retention_milliseconds = 2592000000,
       cleanup_batch_size = 1000,
       updated_at = now()
 WHERE scope = 'default';
COMMIT;
```

Reducing retention makes rows eligible on the next command; it does not synchronously delete them.
Before changing policy, confirm incident, audit, backup, and legal-hold requirements. M10.12 does not
implement a legal-hold override.

## Replay boundary

- A retained Action key still returns the original accepted fact or rejects conflicting reuse.
- An expired Action row can only be removed from a stale generation or non-live Session; retrying
  that old target fails generation/status validation before a PTY write.
- A completed Inbox row can be removed only after its Outbox row is gone. If a broker redelivers
  later, the Worker must re-inspect the current Execution/Session tuple; a completed, stale, or
  missing Execution cannot dispatch.
- An Approval request key can begin a new proposal after the retained history expires, but it does
  not inherit an old Human decision or consumed authority.

## Rollback and recovery

Migration 019 is forward-only during ordinary operation. Before an older binary runs, stop all
maintenance and writers, take and verify a backup, and confirm the older process does not assume
unbounded history. Deleting the policy or indexes while maintenance runs is unsupported.

If maintenance fails, the transaction rolls back all four classes. Fix the database/policy error and
rerun; never infer partial cleanup from process output that lacks a successful JSON result.

## Still required outside M10.12

- Actor, Session, Generation, Snapshot, Checkpoint, and fork-lineage lifecycle.
- Recording/Artifact export, legal hold, restore tests, secure erase, and archive storage.
- Always-on scheduling, externally delivered alerts, filesystem/tablespace quota, WAL/backup policy,
  physical compaction, and disk-full drills.
