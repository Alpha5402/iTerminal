# M10.12 normalized-fact retention and database capacity verification

**Result: PASS at L2 for dependency-aware terminal-fact retention and PostgreSQL database-capacity
status.**

Date: 2026-08-31

Platform: macOS arm64, Node.js 24.15.0, pnpm 10.33.2, disposable `postgres:17-alpine`
`iterminal_test` database on tmpfs and loopback

## Scope

- Apply forward-only migration 019 to a real PostgreSQL 17 database.
- Delete only old terminal/expired Approvals, committed-published Outbox rows, completed Inbox rows
  after their same-ID Outbox row is gone, and stale/non-live terminal Action families with no
  retained reference.
- Keep current-generation Action idempotency, stale-generation rejection, pending delivery, active
  Inbox, recent Approval/Outbox, and Event-referenced Action facts intact.
- Bound one invocation by the configured per-class batch and serialize it through the policy row.
- Exercise metadata-only `facts:maintain` and `capacity:inspect` entrypoints against the real
  database, including the distinct CRITICAL exit status.
- Re-run the existing Approval, Artifact, and Event retention repository suites with migration 019
  present.

## Commands and results

```sh
pnpm typecheck
pnpm lint
```

Result: TypeScript and ESLint passed after the production changes.

```sh
ITERM_DATABASE_URL=postgresql://iterminal_test:<redacted>@127.0.0.1:55432/iterminal_test \
  pnpm test:m10:retention
```

Result: 3 files and 21 tests passed against PostgreSQL. This includes 3 new migration 019 tests plus
the existing Runtime/Approval and Observation/Artifact/Event retention suites.

```sh
ITERM_DATABASE_URL=postgresql://iterminal_test:<redacted>@127.0.0.1:55432/iterminal_test \
  pnpm --silent facts:maintain
```

Result: exit 0 with only `deletedActions`, `deletedApprovals`, `deletedInboxRows`,
`deletedOutboxRows`, and bounded policy metadata. The clean post-test database reported zero for
each deletion class.

```sh
ITERM_DATABASE_URL=postgresql://iterminal_test:<redacted>@127.0.0.1:55432/iterminal_test \
  pnpm --silent capacity:inspect
```

Result: the default 10 GiB/80% policy returned `HEALTHY` and exit 0. A controlled one-byte policy
returned `CRITICAL`, zero available bytes, and exit 2 while still printing valid aggregate JSON.

```sh
env 'ITERM_DATABASE_URL=postgresql://operator:<sentinel>@127.0.0.1:1/iterminal?token=<sentinel>' \
  pnpm --silent facts:maintain
env 'ITERM_DATABASE_URL=postgresql://operator:<sentinel>@127.0.0.1:1/iterminal?token=<sentinel>' \
  pnpm --silent capacity:inspect
```

Result: both refused-connection paths exited 1 with exactly their fixed operation message. The fake
password/query sentinel and raw PostgreSQL driver diagnostics were absent.

```sh
pnpm verify
```

Result: PASS. Prettier, ESLint, TypeScript, 35 test files / 130 tests, all 52 milestone reports, and
the production build passed. Another 33 test files / 102 tests remained explicitly skipped by their
declared environment gates. Vite retained the existing advisory for the 547.15 kB minified Console
chunk; it did not fail the build. The separate PostgreSQL gate above supplies the real database
evidence that the default no-database suite intentionally skips.

## Verified behavior

| Boundary                   | Evidence                                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval authority         | Old `CONSUMED` and already-expired `APPROVED` rows are deleted; a recent `DENIED` row remains. No deleted decision can authorize an Execute.                                                              |
| Outbox uncertainty         | An old committed-published row is deleted; pending and recent rows remain. Cleanup never treats row age as proof of publish.                                                                              |
| Inbox deduplication window | An old completed row is deleted only after the same-ID published Outbox row is removed in the transaction; a completed row with pending Outbox and a `PROCESSING` row remain.                             |
| Action dependencies        | An old stale-generation Execute and non-Execute Action are removed; an Event-referenced Action and a current live-generation Action/Execution remain.                                                     |
| Idempotency after cleanup  | Repeating the retained current-generation key returns the original Action. Repeating the removed stale-generation key returns `SESSION_GENERATION_CHANGED` and creates no Action or Outbox dispatch fact. |
| Bounded maintenance        | With `cleanup_batch_size=1`, two concurrent repository instances serialize through the policy and each reports exactly one of two eligible Outbox deletions.                                              |
| Existing retention paths   | Approval repository, Artifact logical-byte/expiry maintenance, Event contiguous-prefix retention, and cursor watermark tests all stay green with migration 019.                                           |
| Capacity classification    | Real `pg_database_size` produces exact decimal byte strings and HEALTHY/WARNING/CRITICAL classifications; CRITICAL has a dedicated operator exit status.                                                  |
| Operational output         | Both commands emit aggregate policy/count/size metadata without commands, payloads, Actor identities, paths, endpoint strings, or grants.                                                                 |

## Failed attempts and corrections

- Prettier has no SQL parser in this repository, so migration 019 is excluded from the targeted
  formatter invocation and is checked by PostgreSQL execution plus `git diff --check` instead.
- The Action eligibility predicate initially used `IS DISTINCT FROM` directly against a nullable
  left-joined Execution. That would pin terminal non-Execute Actions when both values were null. The
  final predicate explicitly admits `execution.id IS NULL`; the real PostgreSQL fixture verifies
  one old Input Action is deleted.

## Not proven

- Actor/Session/Generation/Snapshot/Checkpoint/fork-lineage deletion, legal hold, export/archive,
  restore, secure erase, or regulatory retention suitability.
- A filesystem/tablespace hard quota, transaction-level disk reservation, WAL/archive/backup
  capacity, autovacuum tuning, physical compaction, or disk-full recovery.
- Remote alert delivery, an always-on scheduler, multi-database aggregation, or a production
  monitoring integration.
- Broker retention beyond the retained Inbox window, arbitrary message types beyond the current
  `ExecutionReady` inspection contract, or queue storage bounds.
- Long-duration cleanup pressure, concurrent production writers at release scale, cross-platform
  PostgreSQL deployments, or repository release readiness.

## Conclusion

M10.12 closes the planned L2 bounded cleanup path for terminal Approval, Action-family,
published-Outbox, and completed-Inbox rows without weakening live generation or unknown-delivery
truth. It also provides a real whole-database capacity signal. Physical enforcement and broader
lifecycle/export policy remain explicit follow-up work.
