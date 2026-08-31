# PostgreSQL database capacity operations

M10.12 reports the physical allocation visible through `pg_database_size(current_database())`.
Unlike logical Artifact counters, this sample includes PostgreSQL heap, indexes, and accumulated
free/dead space inside the database. It does not include every WAL, archive, backup, or host
filesystem consumer.

## Default policy

Migration 019 creates `database_capacity_policies.default`:

| Setting           | Default | Meaning                                      |
| ----------------- | ------: | -------------------------------------------- |
| `max_bytes`       |  10 GiB | `CRITICAL` threshold for the observed sample |
| `warning_percent` |     80% | `WARNING` threshold below `max_bytes`        |

The default is a development baseline, not a production sizing recommendation. Set it below the
real filesystem/tablespace limit with enough headroom for WAL, autovacuum, maintenance rewrites,
backups, and incident recovery.

## Inspect and alert

```sh
ITERM_DATABASE_URL=postgresql://... pnpm capacity:inspect
```

The command applies migrations and prints bounded aggregate JSON containing `usedBytes`,
`availableBytes`, `usedPercent`, the policy, and one of `HEALTHY`, `WARNING`, or `CRITICAL`.
`CRITICAL` exits with status 2; configuration/connection failures exit 1. A monitoring wrapper can
page on status 2 and warn on the JSON status without scraping logs or database credentials.
`usedPercent` has two-decimal precision below the critical threshold and saturates at 100 once the
sample reaches or exceeds `max_bytes`; use exact decimal-string `usedBytes` for overage calculation.

For an ordered writable-primary endpoint list, use `ITERM_DATABASE_URLS`. The result is a sample of
the selected database at query time. It is not an atomic reservation and can change immediately.

## Change thresholds

```sql
BEGIN;
UPDATE database_capacity_policies
   SET max_bytes = 53687091200,
       warning_percent = 80,
       updated_at = now()
 WHERE scope = 'default';
COMMIT;
```

`max_bytes` must be a positive JavaScript-safe integer and `warning_percent` must be 1–99. Changing
the policy does not allocate storage, reject writes, or delete data.

## Respond to WARNING or CRITICAL

1. stop optional/high-volume producers without replaying unknown writes;
2. inspect aggregate Artifact/Event/normalized-fact state and pending Outbox delivery;
3. run only the applicable bounded maintenance commands under approved retention policy;
4. confirm autovacuum health and filesystem/tablespace/WAL/archive capacity outside iTerminal;
5. expand storage or move/archive data under an explicit operator plan;
6. rerun `capacity:inspect` and verify Runtime durability before resuming admission.

Ordinary DELETE makes space reusable inside PostgreSQL but may not reduce `pg_database_size` or
return blocks to the filesystem immediately. `VACUUM FULL`, table rewrites, and tablespace moves need
extra working space and locks; they are deliberately not automated here.

## Hard-limit boundary

This command is an alert source, not a hard disk quota. PostgreSQL has no portable transaction-level
per-database physical-byte reservation that matches `pg_database_size`. Production deployments must
also enforce a volume/tablespace quota and monitor filesystem free space, WAL, archives, and backups.
Do not describe a `CRITICAL` sample as proof that no later write can commit, or a `HEALTHY` sample as
proof that the host cannot fill.
