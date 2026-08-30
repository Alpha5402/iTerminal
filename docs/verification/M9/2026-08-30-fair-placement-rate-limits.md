# M9.4 atomic fair placement and durable Action rate limits verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, three Runtime daemon instances, concurrent Unix RPC, node-pty/zsh, drain, cross-owner Actor admission, and per-Session multi-Actor admission).** Atomic placement claims distribute concurrent root-Session attempts evenly across unexpired ACTIVE owners, and durable fixed-window counters enforce Actor and Session Action limits inside the same PostgreSQL transaction as admission.

This proves the M9.4 local fairness and admission-control slice. It does not prove capacity-weighted scheduling, OS-process crash behavior during placement, hostile identity cardinality, asymmetric partition, remote process reclamation, or the M9 L4 chaos/soak Exit Gate.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- pnpm: 10.33.2
- PostgreSQL: 17-alpine, disposable `iterminal_test`, tmpfs-backed, bound to `127.0.0.1:55432`
- Runtime transport: one stable Router socket plus separate absolute mode-`0600` Unix sockets per daemon
- Shell/PTY: real zsh through node-pty
- Rate-limit test policy: 2 Actions / 5,000 ms per Actor and per Session for the multi-owner scenario; 1 Actor Action / 100 ms for rollback/reset persistence fixtures

Database suites refuse to mutate a database not named exactly `iterminal_test`. Shared migration/truncation tests run with one Vitest Worker.

## Commands and results

```bash
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm test:m9:fairness

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
  packages/persistence-postgres/src/postgres-runtime-repository.test.ts \
  packages/persistence-postgres/src/postgres-interaction-guard.test.ts \
  packages/persistence-postgres/src/postgres-terminal-geometry.test.ts \
  packages/persistence-postgres/src/postgres-session-fencing.test.ts \
  packages/persistence-postgres/src/postgres-action-rate-limit.test.ts \
  packages/persistence-postgres/src/postgres-runtime-owner-registry.test.ts \
  apps/runtime-daemon/src/interaction-policy.test.ts \
  apps/runtime-daemon/src/resize.test.ts \
  apps/runtime-daemon/src/session-fork-durable.test.ts \
  apps/runtime-daemon/src/session-rebuild-durable.test.ts \
  apps/runtime-router/src/runtime-router.test.ts

pnpm verify
```

- Focused placement/rate-limit/Router suite: 3 test files / 9 tests passed.
- Affected PostgreSQL/PTY regression: 11 test files / 26 tests passed.
- Static checks before final documentation: Prettier, ESLint, and TypeScript passed.
- Full repository quality gate: 20 test files / 80 tests passed; 24 environment-gated files / 63 tests skipped; 29 milestone reports verified; Prettier, ESLint, TypeScript, and production build passed. The build retains the existing advisory for one 542.81 kB minified Console chunk.

## Proven scenarios

| Scenario              | Result                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Atomic claim          | Four independent registry clients issue 12 concurrent claims across three owners; PostgreSQL serializes the decisions and returns exactly 4/4/4  |
| Real Router placement | One stable Router concurrently creates 12 real zsh Sessions across three Runtime daemons with exact 4/4/4 assignment                             |
| Lease uniqueness      | Every created generation has exactly one unreleased Session lease; no duplicate live fence appears                                               |
| Drain                 | After the middle owner enters DRAINING, six new Sessions go 3/3 to the remaining ACTIVE owners; the drained owner remains at four attempts       |
| Attempt semantics     | Placement count is monotonic and consumes a forwarded attempt even if later Session creation fails; it is not decremented on close               |
| Cross-owner Actor     | One Actor admits two Executes through two different Runtime owners; a third Session is rejected as retryable `RATE_LIMITED`                      |
| Per-Session aggregate | Two distinct Actors admit Actions to one Session; a third Actor is rejected by the Session bucket                                                |
| Retry contract        | Rejection includes subject kind/identity, configured limit/window, and numeric database-derived `retryAfterMilliseconds`                         |
| Idempotent replay     | Replaying the same Execute request returns the original Action and does not consume another quota unit                                           |
| Transaction rollback  | An injected pre-commit failure rolls Actor/Session counters back with Action, Execution, Event, Session reservation, and Outbox state            |
| Rejected admission    | A rate-rejected Session remains READY with zero Action rows and no durable reservation                                                           |
| Window reset          | PostgreSQL time rolls an expired fixed window and admits the identical previously rejected request with a fresh count of one                     |
| Regression            | Execute, Input, Control, Resize, interaction policy/Guard, fork/rebuild, owner registry, Session fencing, and Router paths retain prior behavior |

## Architecture boundary verified

- The Router calls one database operation that acquires a dedicated transaction advisory lock, chooses by `(placement_count, owner_id)`, locks the owner row, increments the attempt count, and returns that exact incarnation.
- Only unexpired ACTIVE owners are claimable. DRAINING remains routable only for existing exact Session/Execution targets.
- Placement attempts are a monotonic audit/scheduling fact, not current Session count, capacity, CPU, memory, or queue depth.
- Actor and Session buckets use PostgreSQL `now()` and a fixed Actor-then-Session lock order. They are foreign-keyed to durable identities and removed when those identities are deleted.
- Idempotency and semantic/CAS checks run before rate consumption. The counter update and business mutation share one transaction, so rejection or later failure commits neither.
- `RATE_LIMITED`, `BACKPRESSURE`, `PTY_BUSY`, policy denial, owner-route failure, Session fencing, and Execution expected-version conflicts remain distinct contracts.
- In-memory mode is explicitly development-only and does not claim cross-process rate limiting.

## Exploratory failure resolved

- The first multi-owner rate-limit test assumed that the first two results from concurrent `Promise.all` creation must belong to different owners. Concurrent completion order has no such contract even though durable placement was 2/2. The fixture now groups returned Sessions by `ownerId`, then deliberately exercises the same Actor through both owners; the implementation did not change.
- The first full quality-gate run was confined by a filesystem/network sandbox and 14 Unix/TCP listener attempts failed with `EPERM`; 62 other tests passed. The identical `pnpm verify` command outside that restriction passed all 80 enabled tests, so the environment failure is not recorded as a product regression.
- A later focused rerun exposed the Router fixture's inherited 500 ms owner lease: under a slow test turn, one Session fence could expire despite the 50 ms supervisor loop. The fixture now gives both owner and Session leases 5 s, matching their renewal scale. The complete 9-test M9.4 suite and a separate repeated 4-test Router run pass with that deterministic fixture; production defaults remain 15 s.

## Not proven

- Separate operating-system Router/Runtime processes killed with actual `SIGKILL` during an in-flight claim or Action admission.
- Capacity weights, equal active Session load, claim cancellation, overload shedding, database saturation behavior, or fairness under heterogeneous owners.
- Asymmetric/minority network partition, correlated PostgreSQL/RabbitMQ outage, CPU-starved heartbeat scheduling, database clock pathology, or long soak.
- Hostile unbounded Actor-ID creation, distributed quota administration, bucket retention/GC policy, sliding-window accuracy, or boundary-burst prevention.
- Remote endpoints, peer credentials, authentication/TLS, authorization/Approval, secret-channel/redaction, hostile local users, or release hardening.
- Live PTY migration/failover, takeover of an old generation, remote process-group reclamation, or exactly-once Shell/external effects.
- Browser Human Console or autonomous model-driven Agent L3 path through three or more Runtime owners.
