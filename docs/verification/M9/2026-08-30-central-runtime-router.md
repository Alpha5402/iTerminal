# M9.2 central Runtime Router verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, two Runtime owner daemons, independent node-pty/zsh PTYs, stable Router Unix RPC, official MCP SDK over stdio, and RabbitMQ 4.3 queue dispatch).** One Router socket places new Sessions on ACTIVE owners and forwards exact Session/Execution operations to their durable owner. DRAINING owners retain existing traffic but receive no new Session; missing/stopped routes fail before owner RPC, and an uncertain mutating endpoint failure remains `DELIVERY_UNKNOWN`.

This proves the M9.2 central local routing slice. It does not implement generation-scoped Session leases/fencing, cross-owner PTY migration, stale durable-write rejection, or the M9 L4 multi-Worker exit gate.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- pnpm: 10.33.2
- PostgreSQL: 17-alpine, disposable `iterminal_test`, tmpfs-backed, bound to `127.0.0.1:55432`
- RabbitMQ: 4.3-alpine, disposable single broker, bound to `127.0.0.1:5673`
- Shell/PTY: two independent real zsh processes through node-pty
- Agent path: official MCP TypeScript SDK v2 Client → stdio bridge → stable Router Unix RPC → exact owner Unix RPC → Runtime/PTY
- Queue path: PostgreSQL Outbox → RabbitMQ confirm → router-mode Execution Worker/Inbox → Router → exact owner

The suites refuse to mutate a database not named exactly `iterminal_test`. Shared database tests run with one test Worker because they migrate and truncate the same disposable schema. Every Runtime and Router uses a distinct short mode-`0600` Unix socket under `/private/tmp`.

## Commands and results

```bash
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
ITERM_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5673 \
  pnpm test:m9:router

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm test:m9:registry

pnpm verify
```

- M9.2 Router/MCP/queue suite: 4 test files / 10 tests passed.
- M9.1 registry regression: 2 test files / 4 tests passed.
- Runtime RPC shutdown/delivery regression: 1 test file / 6 tests passed.
- Full repository gate: 20 test files / 80 tests passed; 22 environment-gated files / 55 tests skipped; 27 milestone reports verified; Prettier, ESLint, TypeScript, and production build passed.

The production build retains the existing advisory for one 542.81 kB minified Console chunk. It is a bundle-optimization warning, not a build failure.

## Proven scenarios

| Scenario                | Result                                                                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable protocol surface | Router implements the existing `RuntimeGateway`; MCP changes only `ITERM_RUNTIME_SOCKET`, and the official SDK sees the same tool surface                                                                         |
| Deterministic placement | With two equal ACTIVE owners, owner ID breaks the tie; durable active-Session count sends the next Session to the other owner                                                                                     |
| Exact Session route     | Real owner-routed get/Execute/wait, Screen get/region/cells/diff/search/wait, TerminalState, Events, interaction read, Resize, targeted Input/Control, checkpoint/fork, and close use durable `sessions.owner_id` |
| Exact Execution route   | Dispatch/get/wait resolve `executions.owner_id`, not message ordering or a client-selected owner                                                                                                                  |
| Shared Shell continuity | MCP mutations routed to one owner preserve exported environment and cwd across later routed Execute calls                                                                                                         |
| Complete list           | Router resolves every distinct non-closed durable Session owner, rejects missing/unreachable owners, unions owner results, detects duplicate Session IDs, and returns deterministic ordering                      |
| Drain                   | A DRAINING owner remains routable for an existing Session but disappears from new-Session placement                                                                                                               |
| Missing/stopped route   | Existing durable targets with no unexpired ACTIVE/DRAINING registry row return retryable `OWNER_ROUTE_UNAVAILABLE`; no replacement PTY is created                                                                 |
| Missing target          | Unknown Session/Execution IDs remain `SESSION_NOT_FOUND`/`EXECUTION_NOT_FOUND`, distinct from owner unavailability                                                                                                |
| Endpoint failure        | An absent registered endpoint maps reads to owner-route unavailability; mutating delivery remains conservatively `DELIVERY_UNKNOWN` and is not retried                                                            |
| Queue across owners     | One explicit router-mode Worker consumes two owner-independent wake-ups, rechecks both Executions in PostgreSQL, dispatches each exact PTY once, and completes two Inbox rows                                     |
| Owner-local regression  | The same queue suite retains the four M8 owner-bound dispatch/crash tests; router mode does not silently disable the default owner equality guard                                                                 |

## Exploratory failures resolved

- The first Router integration run used descriptive temporary directory names that exceeded macOS's Unix-domain socket path limit and failed with `listen EINVAL`. Fixtures now use bounded `/private/tmp/itr-m92-*` paths; both routing scenarios pass.
- Adding the twentieth workspace package forced pnpm to rebuild `node_modules`; the restricted sandbox could not read one missing tarball. The locked dependencies were restored with the approved package-manager path, and no dependency versions changed beyond new workspace links.

## Architecture boundary verified

- The Router owns no PTY, Shell, Virtual Screen, state machine, Inbox, or durable Action transition.
- Session/Execution owner plus live registry incarnation are read in one PostgreSQL statement; no stale process-lifetime route cache is used.
- Migration 008 adds a partial live-Session owner index for placement counts and complete owner enumeration; exact Session/Execution lookups retain their primary-key paths.
- New placement sees only unexpired ACTIVE owners. Existing exact routes and complete listing accept ACTIVE or DRAINING.
- PostgreSQL is the routing source of truth. Database errors have no stale-route fallback.
- Owner endpoint failure classification retains the established mutation uncertainty boundary.
- Execution Worker routing mode is explicit: `owner` remains default; `router` accepts any PostgreSQL-inspected owner and delegates exact routing.
- The Router never registers in `runtime_workers` because it owns no PTY.

## Not proven

- Generation-scoped Session Lease, renewal, fencing token, or owner/instance/generation/token validation in every durable mutation.
- Rejection of stale owner writes during the route-lookup-to-heartbeat race; registry freshness is not Session fencing.
- Three or more owners under concurrent placement, serializable fairness, per-actor/session rate limits, capacity weights, or overload shedding.
- Router PostgreSQL cold start/reconnect supervision, Router process crash during a forwarded call, silent Router-to-owner socket blackhole, or long soak.
- Cross-owner checkpoint rebuild/fork placement, old process-group reclamation after partition, or live PTY migration/failover.
- Browser Human Console through the Router, cross-browser behavior, or autonomous model-driven multi-owner decisions.
- Remote endpoints, peer credential verification, hostile local socket replacement, authentication/TLS, authorization, approvals, secret redaction, or release hardening.
- Exactly-once Shell effects. RabbitMQ and Router forwarding remain at-least-once/uncertain-delivery systems with explicit Inbox and `DELIVERY_UNKNOWN` boundaries.
