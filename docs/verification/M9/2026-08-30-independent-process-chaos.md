# M9.5 independent-process multi-owner chaos verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, one independent Router process, three independent Runtime processes, real node-pty/zsh, Router and Runtime `SIGKILL`, same-owner replacement, and graceful `SIGTERM`).** Router process loss does not lose durable routes, Runtime process loss cannot transfer an old generation, replacement preserves only `BROKEN/UNKNOWN` history, and placement continues on live owners with exactly one Session lease per new generation.

This proves the composed M9.5 local process-chaos slice. It does not prove asymmetric partition, remote-host process reclamation, kill during an in-flight mutating forward/claim transaction, capacity-weighted overload behavior, or the complete M9 L4 chaos/soak Exit Gate.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- pnpm: 10.33.2
- PostgreSQL: 17-alpine, disposable `iterminal_test`, tmpfs-backed, bound to `127.0.0.1:55432`
- Process topology: one `apps/runtime-router/src/main.ts` child plus three `apps/runtime-daemon/src/main.ts` children; replacement Runtime is a fourth boot incarnation
- Runtime transport: one stable Router socket plus separate absolute mode-`0600` owner sockets under `/private/tmp`
- Shell/PTY: real zsh through node-pty
- Test lease policy: 2,000 ms owner and Session leases; 100 ms database health/renewal interval

The suite refuses to mutate a database not named exactly `iterminal_test`. Each run truncates owner/session test state, and child cleanup uses graceful `SIGTERM` with bounded `SIGKILL` fallback.

## Commands and results

```bash
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm test:m9:process-chaos

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
  apps/runtime-router/src/process-chaos.test.ts \
  apps/runtime-router/src/runtime-router.test.ts \
  packages/persistence-postgres/src/postgres-runtime-owner-registry.test.ts \
  packages/persistence-postgres/src/postgres-session-fencing.test.ts

pnpm verify
```

- Independent-process chaos test: 1 file / 1 scenario passed twice consecutively.
- Affected M9 regression: 4 files / 10 tests passed.
- Full repository quality gate: 20 test files / 80 tests passed; 25 environment-gated files / 64 tests skipped; 30 milestone reports verified; Prettier, ESLint, TypeScript, and production build passed. The build retains the existing advisory for one 542.81 kB minified Console chunk.

## Proven sequence

| Phase                 | Result                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent topology  | Parent test launches one Router and three Runtime OS child processes, each Runtime owning independent real zsh PTYs                                 |
| Concurrent placement  | 12 root Sessions created through the Router distribute exactly 4/4/4 across the three ACTIVE owners                                                 |
| Router crash          | Router receives actual `SIGKILL`; Runtime children and PTYs survive; a fresh Router process on the stable socket resolves the existing Session      |
| Active owner crash    | Owner B runs `sleep 30`, then receives actual `SIGKILL`; the observed Shell PID disappears and exact routing fails closed                           |
| Replacement fencing   | Boot-unique owner B replacement waits for lease expiry, registers epoch 2, and never acquires the old generation's PTY/lease                        |
| Durable recovery      | Victim Session becomes `BROKEN`, durable Execution becomes `UNKNOWN`, victim lease is released, and RPC does not fabricate the historical Execution |
| Replacement-only work | Three new Sessions distribute one per owner; owner B's new Session ID executes a real zsh command successfully while the victim remains `BROKEN`    |
| Graceful drain/stop   | Owner C receives `SIGTERM`, closes its Sessions, releases leases, and persists `STOPPED`                                                            |
| Post-stop placement   | Four later Sessions distribute 2/2 across owners A/B; stopped owner C receives none                                                                 |
| Lease invariant       | Every checked live replacement generation has exactly one unreleased lease; the killed generation's lease has `released_at`                         |

## Architecture boundary verified

- Router process identity is not a Runtime owner identity and carries no durable PTY authority.
- Stable logical owner ID, boot instance ID, registry epoch, Session fencing token, and Execution expected version remain distinct.
- Same-owner replacement is delayed until database-time owner lease expiry and advances the registry epoch.
- Replacement reconciliation is destructive to stale liveness claims: old live Sessions become `BROKEN`, ambiguous Executions become durable `UNKNOWN`, and old leases are released.
- Historical `BROKEN` Session projection is intentionally richer than live Execution reconstruction; `execution.get` does not fake a process-local object after restart.
- Graceful drain and crash expiry are different lifecycle paths, but neither reroutes an old Session to another owner.

## Exploratory failures resolved

- The first run expected `execution.get` on the replacement daemon to return the durable `UNKNOWN` row. The runtime intentionally hydrates only bounded `BROKEN` Session reconstruction projections and does not invent old Execution objects. The final fixture expects `EXECUTION_NOT_FOUND` at live RPC while independently asserting the PostgreSQL Execution is `UNKNOWN`.
- The first repeated run reused a boot instance ID whose previous cleanup had persisted `STOPPED`. Registration correctly rejected resurrection of the same boot incarnation. The isolated test now truncates `runtime_workers` together with Session state; production registration semantics were not weakened.

## Not proven

- Router death after a mutating request may have reached an owner, or Router death while a placement claim transaction is in progress.
- Asymmetric/minority network partition, correlated PostgreSQL/RabbitMQ outage, database lock/saturation collapse, clock pathology, or CPU-starved heartbeat scheduling.
- Sustained concurrent create/close traffic during repeated rolling drains, high owner counts, fairness over long duration, or soak/resource-leak behavior.
- Capacity weights, active-load balancing, overload shedding, claim cancellation, or heterogeneous owner performance.
- Remote host/process-group reclamation when the old machine is unreachable; local Shell disappearance after parent `SIGKILL` is not a remote fencing mechanism.
- Live PTY migration/failover, takeover of an old generation, reconstruction of process/REPL/editor state, or exactly-once external effects.
- Browser Human Console or autonomous model-driven Agent path through this process-chaos topology.
- Authentication/TLS, peer credentials, authorization/Approval, secret-channel/redaction, hostile local users, packaging, or release hardening.
