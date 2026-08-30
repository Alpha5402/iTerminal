# M9.15 capacity-weighted Runtime placement verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 16, concurrent registry clients, one independent Router, three independent Runtime processes, drain/replacement, and real node-pty/zsh execution).** Runtime owners declare bounded relative weights, PostgreSQL atomically assigns new root Sessions by normalized historical placement debt, equal defaults remain compatible, and weighted shares survive drain and boot-unique same-owner replacement without changing fencing semantics.

## Environment and commands

- Disposable PostgreSQL 16 Alpine `iterminal_test` on `127.0.0.1:55432`.
- Registry concurrency: four independent PostgreSQL registry clients claiming against owners weighted 1:2:3.
- Process topology: one production Router and three production Runtime children configured with `ITERM_RUNTIME_CAPACITY_WEIGHT=1|2|3`; the weight-3 owner drains and returns as registry epoch 2.
- Real zsh execution on each weight class before drain and after replacement.

```bash
pnpm typecheck

ITERM_DATABASE_URL=postgresql://iterminal:iterminal@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    packages/persistence-postgres/src/postgres-runtime-owner-registry.test.ts

ITERM_DATABASE_URL=postgresql://iterminal:iterminal@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    apps/runtime-router/src/process-chaos.test.ts

pnpm verify
git diff --check
```

- PostgreSQL owner registry regression: 1 file / 9 tests passed.
- Independent-process M9 chaos regression: 1 file / 11 scenarios passed.
- Full repository quality gate: 21 files / 85 tests passed; 25 files / 80 tests skipped by explicit environment gates.
- Verification-document audit: 40 milestone reports passed.
- Production build passed; Vite retained the existing non-blocking 543.01 kB Console chunk warning.

## Proven scenarios

| Boundary                       | Result                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Backward-compatible default    | Existing registrations omit weight and return/persist capacity weight 1                                |
| Configuration validation       | Weight 0 and 1001 fail with `INVALID_REQUEST`; accepted range is 1–1000                                |
| Atomic concurrent distribution | Twelve claims across weights 1:2:3 commit exactly 2/4/6 under four registry clients                    |
| Drain redistribution           | With weight-3 owner DRAINING/STOPPED, six later claims split 2/4 across weights 1:2                    |
| Stable historical debt         | Placement counts survive close, drain, stop, and same-owner replacement                                |
| Replacement identity           | Returning weight-3 owner uses a new boot instance, registry epoch 2, and its persisted weight/count    |
| Catch-up behavior              | After retained normalized debt, 18 replacement-wave claims split 2/4/12                                |
| Final convergence              | Stable-owner counts finish 6/12/18, exactly matching weights 1:2:3                                     |
| Real Runtime path              | Sessions on every capacity class execute unique `printf` markers through real zsh before/after drain   |
| Fencing independence           | Capacity changes no owner lease, Session fencing token, generation, or Execution expected-version rule |

## Failures observed during closure

- Prettier has no SQL parser in this repository, so including migration 013 in a targeted `prettier --write` command returned “No parser could be inferred.” The migration is plain reviewed SQL; repository formatting, typecheck, real PostgreSQL migration, and both targeted suites then passed. No product assertion failed.

## Migration and rollback

- Migration 013 adds/backfills `capacity_weight integer NOT NULL DEFAULT 1` and enforces values from 1 through 1000. Existing owners retain equal behavior.
- The migration is additive and old binaries ignore the column. New binaries run migrations before owner registration and require it for weighted reads. Mixed old/new Routers remain safe but do not guarantee configured ratios until the Router rollout completes.
- Rollback must normalize weights to 1 or accept loss of configured ratios, stop Runtime/Router writers, deploy code older than M9.15, drop `runtime_workers_capacity_weight_check` and `capacity_weight`, then remove schema version 13. Placement counts and Sessions are retained.

## Not proven

- Automatic CPU/memory/cgroup capacity discovery, dynamic autoscaling weights, workload-cost estimation, or active-load feedback.
- Hard concurrent Session limits, overload shedding, queue-depth admission, per-owner backpressure, or noisy-neighbor isolation.
- High owner counts, PostgreSQL planner/index behavior at large registry cardinality, saturation, or long-duration fairness/soak.
- PostgreSQL minority/quorum, remote host reclamation, correlated database/broker failure, live PTY migration, or M9 L4.
- M10 security/release gates or production readiness.
