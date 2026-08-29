# M3 bounded observation verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (PostgreSQL observation and artifact boundary).** PostgreSQL 17 executed real migration, cursor, filtering, attribution, full-text search, artifact, retention-gap, 100,000-line, and slow-consumer scenarios. The live M1 PTY service is not yet wired to this repository.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Database: `postgres:17-alpine`, dedicated `iterminal_test` database
- Binding: `127.0.0.1:55432`; data stored in container tmpfs
- Node.js: 24.15.0
- pg runtime reported by the test stack: 8.23.0

The tests refuse to truncate a database whose `current_database()` is not exactly `iterminal_test`.

## Commands and results

```bash
pnpm verify
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test pnpm test:m3
```

- Full repository gate: exit 0; 4 test files / 11 tests passed, 2 database-only files / 10 tests skipped without a URL, formatting, lint, typecheck, report checks, and build passed.
- PostgreSQL M3 gate: exit 0; 1 file / 4 tests passed in 1.67 seconds.
- The 100,000-line scenario enforces database ingest below 15 seconds, indexed search below 5 seconds, and a serialized 50-Event slow-consumer page below 50,000 characters.

## Proven scenarios

| Scenario                  | Result                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------ |
| Sequence pagination       | Two-Event first page declared `truncated`; opaque cursor resumed the remaining Event |
| Cursor scope              | Reuse against another generation returned `RESYNC_REQUIRED`                          |
| Structured attribution    | Accepted Event returned Agent ID, type, principal, and client                        |
| Execution metadata        | Returned Event range and aggregate output bytes without output body                  |
| 100,009-byte output chunk | Event kept byte count, tail preview, and artifact reference; inline data was absent  |
| Oversized artifact read   | Response was capped at 64 KiB with `truncated` and continuation offset               |
| 100,000 output lines      | FTS returned only FAIL Events 25,000, 50,000, 75,000, and 100,000                    |
| Search context            | Every match returned no more than the requested one Event before/after               |
| Slow consumer             | First page remained 50 Events and declared more data without loading the rest        |
| Removed retention prefix  | Stale sequence request returned `RESYNC_REQUIRED`                                    |

The same PostgreSQL CI job runs M2 and M3 so both migrations and transaction boundaries are exercised together.

## Not proven

- Live PTY output flowing asynchronously into PostgreSQL under backpressure.
- Stable latency, throughput, storage growth, index maintenance, or memory use under production load/soak.
- Object storage, artifact garbage collection execution, encryption, backup, or restore.
- Unicode tokenization beyond PostgreSQL's `simple` text-search configuration.
- Authentication/authorization of cursors and artifacts; M3 is a repository boundary, not a transport.
- M4 MCP, M5 Human Console, or any L3 Human/Agent path.
