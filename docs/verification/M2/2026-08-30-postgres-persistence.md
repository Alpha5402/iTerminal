# M2 PostgreSQL persistence verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (durable repository and transaction boundary).** PostgreSQL 17 executed the real migration, concurrent CAS, idempotency, rollback, recovery, projection, Event allocation, and retention scenarios. The live M1 PTY service is not yet wired to this asynchronous repository.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Docker Engine: 29.4.1
- Database: `postgres:17-alpine`, dedicated `iterminal_test` database
- Binding: `127.0.0.1:55432`; data stored in container tmpfs
- Node.js: 24.15.0
- pg: 8.23.0

The tests refuse to truncate a database whose `current_database()` is not exactly `iterminal_test`.

## Commands and results

```bash
pnpm verify
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test pnpm test:m2
```

- Full repository gate: exit 0; 4 test files / 11 tests passed, the DB-only file was explicitly skipped without a URL, report checks and build passed.
- PostgreSQL gate: exit 0; 1 file / 6 tests passed against the real container.

## Proven scenarios

| Scenario                                     | Result                                                |
| -------------------------------------------- | ----------------------------------------------------- |
| 100 concurrent Execute reservations          | Exactly 1 accepted; 99 structured `PTY_BUSY`          |
| Matching idempotency key/hash                | Original Action/Execution replayed                    |
| Reused key with changed hash                 | `IDEMPOTENCY_KEY_REUSED`                              |
| Failure injected immediately before commit   | Session remained READY; zero Action/Event/Outbox rows |
| Commit followed by lost owner recovery       | Session/generation BROKEN; Execution/Action UNKNOWN   |
| Snapshot and Checkpoint observed-time upsert | Older facts did not overwrite newer facts             |
| 20 concurrent output chunks                  | 20 unique contiguous generation Event sequences       |
| Retention maximum reduced to five            | Five older Events deleted; five retained              |

The accepted transaction stores Session reservation, Actor, Action, Execution, accepted Event, and Outbox atomically.

## Not proven

- The M1 PTY Runtime using PostgreSQL as its live RuntimeStore; it still uses the in-memory adapter.
- A nonblocking SQL ingest/dispatch loop, connection loss behavior, pool saturation, or PostgreSQL failover.
- Migration upgrade/rollback from an older released schema.
- M3 bounded search/artifact behavior, M4 MCP, or any L3 Human/Agent path.
- Production credentials, TLS, backups, restore, HA, or capacity/soak.
