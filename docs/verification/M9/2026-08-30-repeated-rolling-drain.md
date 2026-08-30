# M9.13 repeated rolling owner drain verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 16, one independent Router, three rolling Runtime owner processes, boot-unique replacements, Unix RPC, and real node-pty/zsh execution).** Across six drain/replacement rounds, concurrent uniquely keyed root creates all settle once, each drained incarnation reaches `STOPPED` with no unfinished exact-owner intent, a healthy owner executes real Shell work in every round, and all stable owners finish ACTIVE at registry epoch 3.

## Environment and commands

- Disposable PostgreSQL 16 Alpine `iterminal_test` on `127.0.0.1:55432`.
- One production Router process and three current production Runtime processes; six additional boot incarnations replace owners A/B/C twice each.
- Six batches of eight concurrent root creates: 48 durable caller identities and real zsh PTYs.
- Runtime policy: 2-second owner/Session leases, 100 ms database health interval, 5-second drain deadline.

```bash
pnpm typecheck

ITERM_DATABASE_URL=postgresql://iterminal:iterminal@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    apps/runtime-router/src/process-chaos.test.ts

pnpm verify
git diff --check
```

- Independent-process M9 chaos regression: 1 file / 9 scenarios passed.
- Repeated rolling scenario: 6 drains, 6 replacements, 48/48 root creates settled, and 6/6 healthy-owner zsh commands completed.
- Full repository quality gate: 21 files / 85 tests passed; 25 files / 76 tests skipped by explicit environment gates.
- Verification-document audit: 38 milestone reports passed.
- Production build passed; Vite retained the existing non-blocking 543.01 kB Console chunk warning.

## Proven scenarios

| Boundary                   | Result                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| Repeated lifecycle         | Owners A/B/C drain and replace in order, then repeat for six bounded rounds                        |
| Concurrent admission       | Every round begins eight uniquely keyed root creates before sending the target Runtime `SIGTERM`   |
| Exact settlement           | All 48 callers receive distinct Session IDs; PostgreSQL retains 48 requests and 48 bound Sessions  |
| No abandoned intent        | Each stopped owner has zero unbound creation rows; the final global unfinished count is zero       |
| Placement exclusion        | A draining/stopped incarnation receives no later placement; remaining ACTIVE owners keep serving   |
| Healthy data path          | A non-draining Session completes one unique `printf` command through real zsh in every round       |
| Explicit Session lifecycle | Drained-owner Sessions close during shutdown; other round Sessions are explicitly closed afterward |
| Replacement fencing        | Every replacement uses a fresh instance ID and advances only its stable owner's registry epoch     |
| Final registry state       | All three stable owners are ACTIVE on third boot incarnations with registry epoch 3                |
| Durable terminal state     | All 48 Sessions end `CLOSED`; no hidden PTY takeover or cross-owner replay occurs                  |

## Failures observed during closure

- No product assertion failed in the first real PostgreSQL/process run. Formatting and TypeScript checks passed before the scenario, and the complete nine-scenario process suite passed once in 25.20 seconds.

## Operational and rollback boundary

- Rolling replacement must supply a fresh boot instance ID while preserving the stable owner ID and socket endpoint advertised for that process slot.
- An operator must expect Sessions owned by the drained Runtime to close. Continuity requires explicit checkpoint/rebuild into a new Session; no Router retry or owner replacement moves a live PTY.
- This slice adds no migration or production behavior. Rolling-drain verification can be removed independently, while the M9.12 bounded shutdown contract remains required to avoid abandoned pre-drain placement.

## Not proven

- Multi-hour or multi-day soak, high owner/session cardinality, resource-leak thresholds, fairness over long duration, or production traffic distributions.
- Active Execution behavior at the shutdown deadline, slow clients, deadline expiry under load, or lossless long-lived Session continuity.
- CPU-starved heartbeat scheduling, process-manager/Kubernetes orchestration, remote-host process reclamation, or host reboot.
- PostgreSQL minority/quorum, promotion/replication lag, correlated database/broker loss, cross-region routing, or M9 L4.
- M10 security/release gates or production readiness.
