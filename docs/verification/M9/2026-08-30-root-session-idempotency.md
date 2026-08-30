# M9.8 durable root Session idempotency verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 16, two Runtime processes, replaceable and concurrent Router processes, precise post-forward Router `SIGKILL`, and real node-pty/zsh execution).** A caller-visible root creation key binds placement and Session creation to one durable result. Response loss, exact replay, conflicting reuse, and concurrent multi-Router replay do not create a second Session or PTY.

## Environment and commands

- Disposable PostgreSQL 16 `iterminal_test` on `127.0.0.1:55432`
- Two independent Runtime processes; one crashing Router, one replacement Router, and a second concurrent Router on separate Unix sockets
- Test-only dependency-injected hook after successful `session.create` owner forwarding

```bash
ITERM_DATABASE_URL=postgresql://iterminal:iterminal@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    packages/application/src/runtime-service.test.ts \
    packages/persistence-postgres/src/postgres-runtime-owner-registry.test.ts \
    apps/runtime-router/src/process-chaos.test.ts

ITERM_DATABASE_URL=postgresql://iterminal:iterminal@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    packages/runtime-rpc/src/index.test.ts \
    apps/mcp/src/mcp-stdio.test.ts \
    apps/mcp/src/router-routing.test.ts \
    apps/mcp/src/screen-observation.test.ts \
    apps/mcp/src/session-fork.test.ts \
    apps/mcp/src/terminal-state.test.ts \
    apps/console/src/server.test.ts \
    apps/runtime-daemon/src/durable-runtime.test.ts \
    apps/runtime-daemon/src/interaction-policy.test.ts

pnpm verify
git diff --check
```

- Core idempotency/chaos regression: 3 files / 14 tests passed; all four independent-process M9 scenarios passed.
- Affected RPC/MCP/Console/durable Runtime regression: 9 files / 21 tests passed.
- Additional durability/fencing/Guard/geometry/Router integration regression: 5 files / 15 tests passed.
- Full repository quality gate: 20 enabled files / 81 tests passed; 25 environment-gated files / 68 tests skipped; 33 milestone reports verified; production build passed.
- The existing non-blocking Console chunk-size warning remains at 543.01 kB.

## Proven scenarios

| Boundary                  | Result                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------- |
| First Router claim        | Intent and exact owner incarnation commit with one placement increment                 |
| Owner creation            | Session ID is bound in the same transaction as Session/generation/lease/initial Events |
| Post-forward Router crash | Caller receives `DELIVERY_UNKNOWN`; PostgreSQL retains one intent and one Session      |
| Replacement Router replay | Same key/hash returns the committed Session ID in READY state                          |
| Conflicting key reuse     | Different shell under the same key returns `IDEMPOTENCY_KEY_REUSED`                    |
| Concurrent Router replay  | Two Router sockets return the same Session ID and consume one placement                |
| Live PTY after settlement | Replayed Session executes a real zsh command and reaches `COMPLETED`                   |
| Protocol boundary         | MCP, Console HTTP, CLI JSONL, and raw RPC schemas require the creation key             |

## Not proven

- Router/minority database partition, CPU-starved heartbeat, correlated DB/MQ failure, sustained rolling drain, or long soak.
- Hostile unbounded idempotency-key cardinality, retention cleanup, remote process reclamation, authentication, Approval, or secrets.
- Arbitrary instruction-level crashes inside the owner transaction or exactly-once external effects.
- M9 L4 Exit Gate, cross-platform release readiness, or autonomous-model L3 behavior.
