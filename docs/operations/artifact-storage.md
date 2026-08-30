# Artifact storage operations

M10.5 bounds PostgreSQL Artifact **logical content bytes**. It does not measure PostgreSQL
heap/index/WAL amplification, backup size, filesystem free space, inline Events, or recordings.
Keep database and host capacity alerts in place independently.

## Defaults and invariants

Migration 017 creates one database-authoritative `default` policy:

| Setting                  |    Default | Meaning                                                               |
| ------------------------ | ---------: | --------------------------------------------------------------------- |
| `max_bytes`              |      1 GiB | Maximum aggregate `artifacts.byte_size`                               |
| `max_artifact_bytes`     |     16 MiB | Maximum size of one Artifact row                                      |
| `retention_milliseconds` |     7 days | Database-time expiry assigned at admission                            |
| `cleanup_batch_size`     | 1,000 rows | Maximum rows removed by one maintenance run or admission cleanup pass |

The `artifact_storage_usage` row is maintained by PostgreSQL triggers. Application processes must
not update it. Insert/update admission and delete/truncate accounting lock policy first and usage
second. Artifact/Event creation is atomic, so an Event cannot commit with a missing newly-created
Artifact.

## Inspect without reading content

Use metadata-only SQL:

```sql
SELECT policy.max_bytes,
       policy.max_artifact_bytes,
       policy.retention_milliseconds,
       policy.cleanup_batch_size,
       usage.artifact_count,
       usage.byte_size,
       policy.updated_at AS policy_updated_at,
       usage.updated_at AS usage_updated_at
  FROM artifact_storage_policies policy
  JOIN artifact_storage_usage usage USING (scope)
 WHERE policy.scope = 'default';
```

Do not use `SELECT content FROM artifacts` for routine monitoring.

## Run bounded cleanup

```sh
ITERM_DATABASE_URL=postgresql://... pnpm storage:maintain
```

For an ordered primary endpoint list, use `ITERM_DATABASE_URLS`. The command applies pending
migrations, removes at most one configured batch whose `expires_at <= now()`, and prints one JSON
object containing policy, before/after usage, and deleted row/byte counts. It never prints Artifact
content, hashes, Session IDs, commands, or database credentials.

One run is intentionally bounded. Repeat until `deletedArtifacts` is `0` when draining an expired
backlog. Concurrent invocations use `SKIP LOCKED` and converge under the same policy/usage locks.
Active Artifact admissions also attempt one bounded cleanup pass; an idle installation still needs
the explicit command or an operator-owned scheduler.

## Change policy

Apply changes in one transaction. The database constraints require positive safe-integer values,
`max_artifact_bytes <= max_bytes`, a retention no greater than 10 years, and a cleanup batch from
1 to 100,000 rows.

```sql
BEGIN;
UPDATE artifact_storage_policies
   SET max_bytes = 2147483648,
       max_artifact_bytes = 16777216,
       retention_milliseconds = 604800000,
       cleanup_batch_size = 1000,
       updated_at = now()
 WHERE scope = 'default';
COMMIT;
```

Reducing `max_bytes` below current usage is allowed as a fail-closed operational state: new large
output is rejected until expiry cleanup or Session deletion brings usage below the new limit.
Never delete unexpired evidence merely to make the counter fit without an explicit retention-policy
decision.

## Backpressure and recovery

A direct repository caller receives retryable `BACKPRESSURE` metadata. For a live Runtime output,
the bytes already existed at the PTY boundary and safe replay is impossible. The durability adapter
therefore marks the affected generation `BROKEN`, its active Execution/Action `UNKNOWN`, records a
metadata-only `session.broken`, releases the lease, and closes the local PTY through the Runtime
circuit. Do not retry the command automatically. Inspect the durable history, recover capacity, and
explicitly rebuild/start a new generation if the Human decides that is safe.

## Integrity checks

After migration, maintenance, or incident recovery, these queries must return equal byte/count
values and no oversized rows:

```sql
SELECT usage.artifact_count,
       actual.artifact_count AS actual_artifact_count,
       usage.byte_size,
       actual.byte_size AS actual_byte_size
  FROM artifact_storage_usage usage
 CROSS JOIN (
   SELECT count(*) AS artifact_count, coalesce(sum(byte_size), 0) AS byte_size
     FROM artifacts
 ) actual
 WHERE usage.scope = 'default';

SELECT count(*) AS invalid_rows
  FROM artifacts artifact
 CROSS JOIN artifact_storage_policies policy
 WHERE policy.scope = 'default'
   AND (artifact.byte_size <> octet_length(artifact.content)
        OR artifact.byte_size > policy.max_artifact_bytes);
```

## Rollback boundary

Migration 017 is forward-only during normal operation. Before downgrading:

1. stop every Artifact writer and maintenance invocation;
2. take and verify a database backup;
3. confirm the target binary does not depend on policy/usage tables;
4. remove the three Artifact accounting triggers and functions, then the usage/policy tables and
   the byte-size/content constraint in one controlled database change;
5. restart the old binary only with separate capacity protection.

An old binary reintroduces unbounded expired-row accumulation and has no aggregate admission gate.
Rolling back schema protection without stopping writers is unsupported.

## Still required outside M10.5

- Event/Action/Approval/Outbox/Inbox retention and cursor-safe deletion.
- Artifact/recording export, legal hold, secure erase, encryption policy, and object-store offload.
- Whole-database and filesystem capacity monitoring, WAL/backup retention, and disk-full drills.

PTY callback aggregation was subsequently implemented by M10.6; see
[ADR-0052](../adr/0052-bounded-pty-output-event-coalescing.md). Cross-platform performance and soak
remain outside this M10.5 operations slice.
