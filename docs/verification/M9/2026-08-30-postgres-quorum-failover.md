# M9.16 PostgreSQL quorum primary failover verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real three-node PostgreSQL 17.11 physical replication, synchronous `ANY 1` commit policy, reachable-minority write failure, explicit former-primary fencing and standby promotion, independent Runtime/Router processes, and real node-pty/zsh recovery).** A reachable primary without either synchronous standby cannot keep a Runtime authoritative. After the external fixture stops that former primary and promotes standby1 with standby2 as its synchronous follower, the same Runtime and Router process IDs discover endpoint index 1, reconcile the old generation to `BROKEN/UNKNOWN`, and create a distinct Session/PTY without replaying the old Shell effect.

## Environment and commands

- Host: macOS Darwin, arm64; Node.js 24.15.0.
- Database topology: PostgreSQL 17.11 Alpine primary plus two physical streaming standbys on isolated Docker network and volumes.
- Initial durability: `synchronous_standby_names = 'ANY 1 (standby1, standby2)'` and `synchronous_commit = 'remote_apply'`.
- Promotion durability: standby1 is preconfigured to require standby2 after promotion; standby2 is reparented to the new timeline before application recovery is accepted.
- Application topology: one independent production Runtime and one independent production Router using `ITERM_DATABASE_URLS` with three ordered URLs; real zsh PTY and filesystem side effects.

```bash
bash scripts/run-m9-postgres-quorum-test.sh

ITERM_DATABASE_URL=postgresql://iterminal:iterminal@127.0.0.1:55442/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    packages/persistence-postgres/src/postgres-endpoints.test.ts

pnpm typecheck
pnpm verify
git diff --check
```

- PostgreSQL quorum/promotion process path: 1 file / 1 scenario passed.
- Endpoint configuration/connection retirement: 1 file / 4 tests passed.
- Full repository test suite: 22 files passed / 26 environment-gated skipped; 87 tests passed / 83 skipped.
- Documentation verification: 41 milestone reports verified.
- Production build: TypeScript build and Console Vite build passed; the existing 543.01 kB minified chunk warning remains non-blocking.

## Proven scenarios

| Boundary                         | Result                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Real initial replication         | Both standbys report `streaming` and `quorum`; primary requires one remote-apply acknowledgement                          |
| Baseline durable path            | Router places one Session and real zsh commits a completed filesystem effect on endpoint index 0                          |
| In-flight generation             | A second zsh Execution writes one marker, remains RUNNING in `sleep 30`, and exposes its real Shell PID                   |
| Reachable minority               | Both standbys pause while primary stays reachable; Runtime heartbeat/write hits its 500 ms statement deadline             |
| Owner-wide safety                | Runtime reports PostgreSQL unavailable and the recorded Shell/process group disappears                                    |
| Bounded route failure            | Minority `session.create` returns `RUNTIME_UNAVAILABLE` within five seconds rather than forwarding to a standby           |
| Explicit former-primary fencing  | The old primary container is stopped before either standby resumes or promotion occurs                                    |
| External promotion               | standby1 is promoted; standby2 follows timeline 2 and appears as its `streaming/quorum` synchronous follower              |
| Primary-only endpoint admission  | Recovery/read-only endpoints are rejected after connection; only `pg_is_in_recovery() = false` and read-write is admitted |
| Same-process endpoint recovery   | Original Runtime and Router PIDs move from diagnostic endpoint index 0 to 1 without restart                               |
| Conservative generation recovery | Old Session becomes `BROKEN`; RUNNING Execution becomes `UNKNOWN`; no old PTY is reconstructed                            |
| Distinct new PTY                 | A new Session runs zsh and appends `recovered` exactly once; final durable Session count is two                           |
| Lost minority intent             | The failed minority creation key is absent after promotion; it was never acknowledged or replayed                         |
| Stable owner identity            | Same boot instance returns ACTIVE at registry epoch 1 only after full reconciliation                                      |
| No credential diagnostics        | Runtime/Router state reports only `endpoint_index`; configured URLs and passwords are not logged                          |

## Failures observed during closure

- The first standby bootstrap failed because the official image's `POSTGRES_HOST_AUTH_METHOD=trust` did not add a replication pseudo-database HBA entry. The isolated primary init fixture now appends an explicit test-network replication rule before base backup.
- The first promotion reached timeline 2, but standby2 appeared `async`: `ALTER SYSTEM` changes on the old primary are local configuration and are not WAL-replicated. The external fixture now preconfigures each promotion candidate's synchronous policy, then proves the promoted primary sees its follower as `quorum`.
- The first successful application recovery timed out only because the test expected `ready endpoint_index=1` while the Runtime diagnostic correctly includes `ready attempt=0 endpoint_index=1`. Durable inspection already showed `BROKEN` and graceful `STOPPED`; the assertion and timeout diagnostics were corrected.
- A sandboxed endpoint unit run produced local socket-denial errors without endpoint rotation. The authorized localhost run then exposed the separate no-SQLSTATE `Query read timeout` form from node-postgres. Explicit connection/timeout messages now retire the client; arbitrary SQL/domain errors still do not rotate endpoints.
- A final clean-topology replay found a Runtime readiness race: the main and admission pools reached the promoted primary, but the lazily used observation pool still targeted the stopped endpoint, so the first new PTY output correctly broke the new Session. Recovery now requires main, admission, and observation pool health on a writable primary before reconciliation and READY.
- The first repository-wide closure run stopped during tests because strict endpoint validation exposed legacy skipped-suite fixtures that constructed repositories with an empty URL; those fixtures now use a non-empty inert localhost URL while the suite remains environment-gated. The same run also found SQLSTATE `57014` was incorrectly classified as endpoint loss; ordinary statement cancellation now remains an application/query failure and does not rotate endpoints.
- The first post-fix replay refused to reuse a previously promoted standby because it was no longer in recovery. The dedicated Compose topology and volumes were removed, and a clean three-node replay then passed; this confirms the fixture fails closed instead of silently testing against stale state.

## Configuration and rollback

- `ITERM_DATABASE_URLS` is an ordered comma-separated list used by Runtime, Router, Outbox relay, and Execution Worker. `ITERM_DATABASE_URL` remains the single-endpoint fallback; configuring both fails at startup.
- Every pool verifies a newly connected server is out of recovery and not transaction-read-only. Infrastructure/read-only/administrative-shutdown/timeout failures poison the connection and advance the next attempt, but never retry the failed SQL or transaction.
- No schema migration is required. Rollback removes `ITERM_DATABASE_URLS`, restores one authoritative `ITERM_DATABASE_URL`, and restarts the affected processes.

## Not proven

- Automatic PostgreSQL failure detection, leader election, promotion, former-primary STONITH, or timeline repair by iTerminal. Those remain external database-control-plane responsibilities.
- Arbitrary asymmetric/split-brain partitions, delayed or stale DNS/service discovery, TLS/auth rotation, cross-region replication, or every synchronous replication policy.
- Zero-RPO for client-unknown transactions, transparent transaction replay, exactly-once Shell effects, or live PTY migration.
- PostgreSQL/RabbitMQ correlated outage and recovery, database rolling upgrade, replica rebuild at scale, storage corruption, disk-full behavior, saturation, or long-duration soak.
- Remote host/process-group reclamation, high-cardinality multi-owner deployment, M9 L4, M10 security/release gates, or production readiness.
