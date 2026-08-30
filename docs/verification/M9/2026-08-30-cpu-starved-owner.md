# M9.14 CPU-starved Runtime owner verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 16, independent Router and Runtime processes, actual `SIGSTOP`/`SIGCONT`, Unix RPC, and real node-pty/zsh execution).** An owner paused beyond its database-time lease cannot renew, drain, or stop through the ordinary lifecycle update. Healthy owners keep serving. When the process resumes, its old PTY is destroyed and durable state is reconciled before the same process may return READY and create a distinct Session/PTY.

## Environment and commands

- Disposable PostgreSQL 16 Alpine `iterminal_test` on `127.0.0.1:55432`.
- One production Router and two production Runtime child processes; owner A is paused with actual OS `SIGSTOP` while owner B remains scheduled.
- Real victim command: `sleep 30`; healthy/recovered commands use unique `printf` markers through zsh.
- Test policy: 2-second owner/Session leases, 100 ms database health interval, and PostgreSQL-time expiry.

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

- PostgreSQL owner registry regression: 1 file / 8 tests passed.
- Independent-process M9 chaos regression: 1 file / 10 scenarios passed.
- Focused CPU-starvation rerun: 1 passed / 9 skipped by test-name filter.
- Full repository quality gate: 21 files / 85 tests passed; 25 files / 78 tests skipped by explicit environment gates.
- Verification-document audit: 39 milestone reports passed.
- Production build passed; Vite retained the existing non-blocking 543.01 kB Console chunk warning.

## Proven scenarios

| Boundary                     | Result                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| Atomic expiry precondition   | Heartbeat, drain, and stop match only an exact owner whose `lease_expires_at > now()`                    |
| Rejected-update immutability | Expired lifecycle attempts leave status, lease expiry, and registry version unchanged                    |
| Actual scheduling pause      | OS `SIGSTOP` suspends owner A for longer than its two-second owner and Session leases                    |
| Routing exclusion            | PostgreSQL still shows the row as ACTIVE history, but Router placement excludes it after database expiry |
| Healthy-owner progress       | Owner B creates a Session and completes `printf m914-starved-healthy` while owner A remains stopped      |
| Resume fencing               | `SIGCONT` drives a second CONNECTING cycle instead of directly extending the expired heartbeat           |
| Local process reclamation    | The recorded zsh Shell PID running `sleep 30` disappears after owner-wide durability fencing             |
| Durable reconciliation       | The victim Session becomes `BROKEN` and its generation lease receives `released_at`                      |
| Controlled same-boot recover | With no replacement winner, owner A re-registers the same instance at epoch 1 only through full recovery |
| New-PTY-only progress        | Recovered owner A creates a different Session ID/generation-1 PTY and executes a real zsh marker         |

## Failure observed during closure

- The first complete process run passed the prior nine scenarios but failed the new diagnostic assertion after 10 seconds. The test expected an `UNAVAILABLE` log line; with PostgreSQL healthy, the supervisor correctly trips the owner circuit and proceeds directly through its second `CONNECTING`/`READY` recovery cycle. The assertion was changed to observe that real state sequence plus Shell PID disappearance and durable `BROKEN`/lease-release facts. The focused scenario and then all ten process scenarios passed.

## Compatibility and rollback

- No migration is required. Existing rows keep their schema and become subject to a stricter atomic `lease_expires_at > now()` predicate for heartbeat, drain, and stop.
- Operators should set owner/Session leases above two health intervals as already required. Scheduling pauses longer than the lease now force conservative PTY loss and recovery rather than a transient owner-liveness revival.
- Rolling back the predicate restores the false ACTIVE window and is unsafe once callers depend on expiry as a routing fence. A rollback should first stop all Runtime/Router processes and deploy the older behavior consistently.

## Not proven

- cgroup CPU quota/throttling, host-wide scheduler pressure, priority inversion, GC pathologies, or multiple simultaneously starved owners.
- Remote-host process reclamation, machine suspend/resume, kernel panic, process-manager/Kubernetes restart behavior, or cross-host clock diagnostics.
- Active external side-effect reconciliation beyond the existing `UNKNOWN` contract, long soak, or resource-leak thresholds.
- PostgreSQL minority/quorum, promotion/replication lag, correlated database/broker loss, cross-region routing, or M9 L4.
- M10 security/release gates or production readiness.
