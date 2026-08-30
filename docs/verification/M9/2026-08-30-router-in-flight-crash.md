# M9.7 Router in-flight crash verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, two Runtime processes, replaceable Router processes, precise Router `SIGKILL`, real node-pty/zsh, and a filesystem side effect).** A committed placement attempt survives a pre-forward Router crash without creating a Session; a committed idempotent Execute survives a pre-response Router crash and settles to one durable Action, one Execution, and one observed Shell side effect.

## Environment and commands

- Disposable PostgreSQL 17 `iterminal_test` on `127.0.0.1:55432`
- Two independent Runtime processes and four successive Router processes on one stable socket
- Test-only dependency-injected hooks after placement claim and after successful `execution.start` forwarding

```bash
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    apps/runtime-router/src/process-chaos.test.ts \
    apps/runtime-router/src/runtime-router.test.ts \
    apps/runtime-router/src/server.test.ts \
    packages/runtime-rpc/src/index.test.ts \
    packages/persistence-postgres/src/postgres-runtime-owner-registry.test.ts \
    packages/persistence-postgres/src/postgres-session-fencing.test.ts

pnpm verify
```

- Affected regression: 6 files / 20 tests passed, including all three independent-process scenarios.
- The independent-process suite passed again after adding the direct post-restart 1/1 placement assertion: 1 file / 3 scenarios.
- Full repository quality gate: 20 enabled files / 80 tests passed; 25 environment-gated files / 66 tests skipped; 32 milestone reports verified; production build passed.
- The existing non-blocking Console chunk-size warning remains at 542.81 kB.

## Proven scenarios

| Boundary           | Result                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Claim committed    | Owner A placement count becomes 1 before forwarding starts                                   |
| Claim Router crash | Caller receives non-retryable `DELIVERY_UNKNOWN`; both owners retain zero Sessions           |
| Claim recovery     | Stateless Router restart assigns the next Session to owner B; counts become 1/1              |
| Mutation committed | Owner B accepts `execution.start`; Router dies after owner result and before client response |
| Mutation recovery  | Same idempotency key returns the original durable work and reaches `COMPLETED`               |
| Effect cardinality | PostgreSQL contains one Action and one Execution; real zsh appends exactly one line          |

## Not proven

- Post-forward `session.create` response loss; root Session creation has no client idempotency key yet.
- Every Input/Control/Resize/Guard/fork/close boundary, arbitrary instruction-level crashes, or malicious clients.
- Router/minority database partition, CPU starvation, correlated DB/MQ loss, sustained rolling drain, or long soak.
- Exactly-once effects, remote process reclamation, authentication, Approval, secrets, or release readiness.
