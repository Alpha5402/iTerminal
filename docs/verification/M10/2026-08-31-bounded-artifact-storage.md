# M10.5 bounded Artifact storage verification

**Result: PASS at L2 for PostgreSQL-authoritative Artifact logical-byte admission, exact usage
accounting, bounded expiry cleanup, the metadata-only maintenance command, and the durability
failure transaction.**

Date: 2026-08-31

Platform: macOS arm64, Node.js 22+, pnpm 10.33.2, PostgreSQL 17 Alpine in a disposable local Docker
container

## Scope

- Apply migrations 001–017 to an empty PostgreSQL 17 database.
- Serialize concurrent Artifact admission against one aggregate budget.
- Enforce per-row limits and defend direct SQL writers with PostgreSQL constraints/triggers.
- Commit bounded expired-row cleanup even when the following admission is rejected.
- Keep usage exact after delete, Session cascade, and repeated one-row maintenance batches.
- Exercise a daemon-created live Session/Execution and exact Session fence, then reject one
  constructed output larger than the configured Artifact limit through `PostgresRuntimeDurability`.
- Verify rejection persists `BROKEN/UNKNOWN`, releases the lease, emits metadata only, and does not
  store the rejected sentinel.
- Run the operator maintenance entry point and the repository-wide verification gate.

## Commands and results

```sh
ITERM_DATABASE_URL=postgresql://iterminal:***@127.0.0.1:<port>/iterminal_test \
  pnpm test:m10:artifact
```

Result: 2 test files passed, 7 tests passed. The repository suite covers concurrent budget
admission, per-row and direct-SQL enforcement, cleanup-on-rejection, cascade accounting, bounded
maintenance, 100k-line bounded observation, and cursor retention behavior. The daemon/durability
suite covers the fail-closed live-generation transaction.

```sh
ITERM_DATABASE_URL=postgresql://iterminal:***@127.0.0.1:<port>/iterminal_test \
  pnpm storage:maintain
```

Result: exit 0 with one metadata-only JSON object containing `policy`, `before`, `usage`,
`deletedArtifacts`, and `deletedBytes`; no Artifact content, Session identifier, command, hash, or
database URL was emitted.

```sh
pnpm verify
```

Result: format, lint, typecheck, default test suite, documentation evidence check, TypeScript build,
and Console production build passed. Database-dependent tests remain separately evidenced by the
targeted PostgreSQL command above.

## Durable failure observations

With `max_artifact_bytes = 1024`, a real daemon-created `sleep 30` Execution was first observed as
`RUNNING` in PostgreSQL. A second durability adapter used the exact active lease fence to append a
6,200-byte `terminal.pty_output`. Admission returned non-retryable, Session-scoped
`RUNTIME_UNAVAILABLE`; PostgreSQL then showed:

- Session and generation `BROKEN`;
- active Execution and ExecuteAction `UNKNOWN`;
- Session lease released;
- exactly one `session.broken` Event with `component = artifact_storage`;
- zero Artifact rows and zero usage bytes;
- zero occurrences of the rejected sentinel in Event payloads and Artifact content.

This is a real PostgreSQL/durability transaction over a Session and Execution created by the real
daemon. The oversized event is constructed at the durability boundary, not emitted as one callback
by the live PTY.

## Not proven

- Real `node-pty` output crossing the Artifact threshold after time/byte aggregation. On this host,
  a one-million-byte PTY write arrived as roughly 1 KiB callbacks, so the current direct-callback
  ingest path kept them inline. This was not proven by M10.5; it is subsequently closed by the
  separate M10.6 verification report.
- Whole-database heap/index/WAL/filesystem bounds, disk-full behavior, alarms, backups, or secure
  erase. The M10.5 budget counts only logical Artifact content bytes.
- Event/Action/Approval/Outbox/Inbox retention, Artifact/recording export, legal hold, per-tenant
  quotas, encryption at rest, or object-store offload.
- Long-running concurrent maintenance soak, multi-host PostgreSQL behavior, or production scheduler
  installation.
- Browser/MCP user interaction for storage policy or maintenance; M10.5 intentionally exposes an
  operator CLI and SQL policy only.
