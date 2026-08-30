# M9.17 host-local Process Guardian verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, independent Runtime/Router/Guardian operating-system processes, real node-pty/zsh, actual Runtime `SIGSTOP/SIGCONT`, frozen database transaction expiry, foreground/background descendant reclamation, and same-owner replacement).** A stopped and Router-unreachable Runtime no longer has to resume before its host-local Shell work becomes non-runnable. The independent Guardian freezes and terminates the registered PTY process set before a delayed filesystem effect, PostgreSQL clears the frozen owner's idle transaction inside the lease budget, and a distinct owner incarnation reconciles the old generation to `BROKEN/UNKNOWN` before creating a new PTY.

## Environment and commands

- Host: macOS Darwin, arm64; Node.js 24.15.0.
- Database: PostgreSQL 17 Alpine in the repository's disposable M2 Compose fixture.
- Application topology: one independent Router, one old Runtime, its separate Guardian child, and one same-owner replacement Runtime/Guardian pair.
- Shell topology: real node-pty/zsh with a foreground `sleep` and a delayed background subshell/filesystem effect.

```bash
pnpm exec vitest run packages/executor-pty/src/pty-process-guardian.test.ts

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    apps/runtime-router/src/remote-reclamation.test.ts

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    packages/persistence-postgres/src/postgres-runtime-owner-registry.test.ts \
    apps/runtime-daemon/src/owner-registry.test.ts \
    apps/runtime-daemon/src/durable-runtime.test.ts

pnpm typecheck
pnpm verify
git diff --check
```

- Guardian process-tree regression: 1 file / 1 test passed.
- Independent Runtime/Router/Guardian replacement scenario: 1 file / 1 test passed in 5.09 s.
- Existing registry/fencing/crash regression: 3 files / 14 tests passed.
- Full `pnpm verify`: 23 test files passed / 27 skipped; 88 tests passed / 84 skipped; 42 milestone reports verified; TypeScript and Console production builds passed. The existing 543.01 kB Vite chunk-size warning remains non-blocking.
- Production build emitted both `dist/packages/executor-pty/src/pty-process-guardian.js` and `pty-process-guardian-child.js`; the durable daemon therefore launches the compiled child entry rather than relying on the development TypeScript loader.

## Proven scenarios

| Boundary                            | Result                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Guardian-before-READY registration  | Real zsh is accepted by the Guardian before the executor factory returns and before Session readiness can be persisted        |
| Lease-derived watchdog              | Guardian renewal follows successful owner heartbeat plus Session-lease renewal; its forced-termination budget precedes expiry |
| Independent failure domain          | Only the Runtime receives actual `SIGSTOP`; the Guardian PID remains scheduled and observable                                 |
| Foreground/background discovery     | Reclamation snapshots the PPID descendant tree plus every process still attached to the same PTY TTY                          |
| Cleanup-triggered effect prevention | Guardian freezes the entire snapshot before TERM/KILL; terminating child `sleep` cannot wake a parent script into `printf`    |
| PID reuse/reparent protection       | Every signal rechecks PID/start identity; KILL does not require stable PPID after orphan reparenting                          |
| Platform exit state                 | A frozen macOS parent may retain a non-runnable `E` exiting child; Linux `Z` and macOS `E` are treated as inactive            |
| Frozen database transaction         | PostgreSQL `idle_in_transaction_session_timeout` clears the stopped Runtime's owner-row lock inside the lease budget          |
| Replacement fencing                 | Same logical owner registers `instance-replacement` at registry epoch 2 only after database-time expiry                       |
| Conservative durable recovery       | Old Session becomes `BROKEN`; its RUNNING Execution becomes `UNKNOWN`; no old PTY is reconstructed                            |
| Router recovery                     | The existing Router resolves the replacement endpoint and creates a distinct Session/new zsh PTY                              |
| No escaped side effect              | Delayed old-host file remains absent; only the replacement command writes `recovered`                                         |
| Old Runtime resume                  | Queued Guardian expiry plus changed registry identity keeps the resumed Runtime unavailable                                   |
| Final cleanup                       | After old-parent resume/exit, old Shell and Guardian PIDs fully disappear                                                     |

## Failures observed during closure

- The first Guardian implementation assumed `node-pty` made the Shell PID an operating-system session leader. Real macOS PTY evidence rejected that assumption. Registration now uses PID/start identity and discovers both the PPID tree and unique PTY TTY membership.
- The first process-tree run killed a child `sleep` before its parent background subshell. That child termination woke the parent and executed the next filesystem effect. Reclamation now freezes the complete snapshot with `SIGSTOP` before TERM/KILL, so cleanup itself cannot advance user code.
- The first forced-kill retry required a stable PPID. After TERM, an orphaned child was reparented and incorrectly skipped. PPID is now used only for the initial tree snapshot; every later signal checks PID plus immutable start identity.
- With the old Runtime frozen, the killed Shell remained as a non-runnable macOS `E` exiting record because its kernel parent could not reap it. The cross-platform assertion distinguishes inactive `Z`/`E` records from runnable processes and still requires final PID disappearance after parent cleanup.
- The first replacement Runtime blocked on `runtime_workers`: `pg_stat_activity` showed the stopped owner `idle in transaction` and the replacement waiting on a transaction-ID lock. Runtime durability/registry pools now set PostgreSQL `idle_in_transaction_session_timeout` within the Guardian/owner-lease budget; the replacement scenario then passed.
- Sandboxed local tests could not execute read-only `ps` identity checks. Authorized same-user host runs were required; this is an environment restriction, not a product fallback to unverified PIDs.

## Configuration and rollback

- Durable Runtime mode starts the Guardian automatically. In-memory development mode does not.
- `ITERM_RUNTIME_GUARDIAN_TERMINATION_GRACE_MS` defaults to 100 ms. Startup requires the owner lease to cover two health-check intervals plus this grace.
- Guardian renewal timeout is recomputed from the conservative owner-heartbeat round trip; slow/uncertain database work cannot extend the watchdog.
- Runtime PostgreSQL pools bound idle transactions to the smaller of statement timeout and the Guardian watchdog budget.
- Rollback removes the Guardian factory wrapper and idle-transaction option. Doing so restores the earlier limitation: fencing can reject old writes but cannot prove a stopped remote Runtime's local process tree was reclaimed before it resumes.

## Not proven

- A real second physical host, VM, container runtime, Kubernetes node, privileged service manager, cgroup, pidfd, or external STONITH/fencing integration.
- Reclamation when the whole host/kernel/scheduler or Guardian process is also frozen, powered off, compromised, or partitioned from every control mechanism.
- Cross-user/root-owned processes, daemonized descendants that deliberately detach from the PTY before the Guardian snapshot, adversarial local PID/TTY manipulation, or arbitrary shell escape techniques.
- Graceful completion of user code after lease loss, live PTY migration, old-generation takeover, transparent transaction replay, or exactly-once Shell effects.
- High-cardinality multi-owner deployment, long-duration rolling drain/soak, M9 L4, M10 security/release gates, or production readiness.
