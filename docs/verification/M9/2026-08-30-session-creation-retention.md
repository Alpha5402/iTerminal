# M9.11 bounded Session creation idempotency verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 16, independent Router and Runtime processes, and real node-pty/zsh execution).** Root-Session idempotency uses one database policy across Router and direct durable Runtime admission. A new key cannot exceed capacity or consume placement, active/in-flight work is not deleted by age, eligible terminal/stale work is reclaimed in bounded batches, and an expired key begins a distinct creation contract.

## Environment and commands

- Disposable PostgreSQL 16 Alpine `iterminal_test` on `127.0.0.1:55432`
- Test policy: capacity 2, retention 100 ms, cleanup batch 2 for the process scenario
- One production Router process and one production Runtime process with real zsh PTYs

```bash
pnpm typecheck

pnpm exec vitest run \
  packages/application/src/runtime-service.test.ts \
  packages/application/src/runtime-durability.test.ts

ITERM_DATABASE_URL=postgresql://iterminal:iterminal@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    packages/persistence-postgres/src/postgres-runtime-owner-registry.test.ts

ITERM_DATABASE_URL=postgresql://iterminal:iterminal@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    apps/runtime-router/src/process-chaos.test.ts

pnpm verify
git diff --check
```

- PostgreSQL policy/concurrency/direct-fallback regression: 1 file / 7 tests passed.
- Independent-process M9 chaos regression: 1 file / 7 scenarios passed.
- Application idempotency/cache regression: 2 files / 12 tests passed.
- Full repository quality gate: 21 files / 84 tests passed; 25 files / 74 tests skipped by explicit environment gates.
- Verification-document audit: 36 milestone reports passed.
- Production build passed; Vite retained the existing non-blocking 543.01 kB Console chunk warning.

## Proven scenarios

| Boundary                 | Result                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| Distributed capacity     | Four concurrent registry clients at capacity 2 commit exactly two distinct keys                   |
| Placement side effects   | Rejected keys do not increment owner placement count                                              |
| Existing-key priority    | An active Session replays its original ID while unrelated new keys receive `BACKPRESSURE`         |
| Live unfinished safety   | An aged unfinished intent remains pinned while its exact owner incarnation is live                |
| Stale unfinished cleanup | The same intent becomes eligible after the exact owner stops and retention has elapsed            |
| Terminal cleanup         | An aged completed intent is reclaimed only after its Session becomes `CLOSED`                     |
| Expiry contract          | Reusing the reclaimed key creates a different Session instead of returning stale in-memory replay |
| Direct Runtime fallback  | Trusted-local durable creation uses the same database capacity and cannot bypass the Router bound |
| Bounded cleanup          | Policy caps each admission sweep; cleanup uses row locks with `SKIP LOCKED`                       |
| Recovered live path      | Reclaimed capacity creates new Sessions and completes real zsh commands                           |
| Durable cardinality      | Final retained request count equals policy capacity while four Sessions remain as history         |

## Failures observed during closure

- The first official `postgres:16` image pull failed twice with Docker Registry EOF. Verification used the already installed official `postgres:16-alpine` image instead.
- The first process run exposed an over-wide critical section: ordinary owner creation also waited on the global placement lock, causing existing short test query deadlines to trip under concurrent placement. The Runtime now reads the Router-created intent first and acquires the global lock only for a genuinely missing direct fallback.
- The same run exposed a stale fulfilled Promise cache: PostgreSQL had reclaimed and reinserted a key, but the owner returned the old closed Session and left the new intent unfinished. Durable mode now caches only in-flight creation; settled replay returns to PostgreSQL. The complete seven-scenario process suite then passed.
- The first final `pnpm verify` stopped at `format:check` after the Application regression command was added to this report. No lint/test/build step ran in that attempt; formatting was applied and the complete final quality gate passed with the counts above.

## Migration and rollback

- Forward migration `012_session_creation_retention.sql` adds/backfills `completed_at`, enforces Session-binding consistency, adds partial retention indexes, and creates the singleton policy row with 24-hour / 100,000 / 1,000 defaults.
- The migration is additive for current code, but old code does not populate `completed_at`. A rollback must first stop all Router/Runtime writers, drop `session_creation_requests_completion_check`, the two retention indexes, `session_creation_policies`, and `completed_at`, remove schema version 12, and only then deploy code older than M9.11. Retained request/session data itself need not be deleted.

## Not proven

- Authenticated per-principal quotas, hostile remote exposure, distributed policy administration API, or tenant isolation.
- Sustained attack traffic, cleanup latency at 100,000 rows, index/storage growth under production distributions, disk-full behavior, or long soak.
- PostgreSQL minority/quorum, promotion/replication lag, correlated DB/RabbitMQ loss, CPU-starved heartbeat, or rolling drain.
- M9 L4, M10 security/release gates, or production readiness.
