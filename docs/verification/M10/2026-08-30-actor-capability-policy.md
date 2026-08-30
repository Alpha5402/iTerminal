# M10.1 Actor capability policy and immutable identity verification — 2026-08-30

**Result: PASS at L2 (real local zsh/PTTY + Unix Runtime RPC + official MCP SDK Agent + PostgreSQL 17).** Actor authority is now an explicit closed capability set, capability denial happens before Action allocation or PTY delivery, and one durable Actor id cannot be rewritten with a different type, principal, client, or capability set.

## Environment

- macOS arm64 host, Node.js 26.4.0, pnpm 10.33.2.
- Disposable `postgres:17-alpine` database named exactly `iterminal_test`, tmpfs-backed and bound to `127.0.0.1:55432`.
- Real local `node-pty` zsh Session, mode-`0600` Unix Runtime socket, Human RPC client, and official MCP TypeScript SDK stdio Agent.
- Migration 14 adds non-null Actor capabilities and backfills existing identities with the canonical profile for their stored type.

The PostgreSQL suites refuse to mutate a database whose name is not exactly `iterminal_test`. The database container, workspace, Unix sockets, PTY, and MCP process are disposable fixtures.

## Commands

```bash
pnpm exec vitest run \
  packages/application/src/interaction-policy.test.ts \
  packages/application/src/runtime-service.test.ts \
  packages/application/src/session-fork.test.ts

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
  packages/persistence-postgres/src/postgres-runtime-repository.test.ts \
  packages/persistence-postgres/src/postgres-observation-repository.test.ts \
  packages/persistence-postgres/src/postgres-interaction-guard.test.ts \
  packages/runtime-rpc/src/index.test.ts

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
  apps/runtime-daemon/src/interaction-policy.test.ts
```

Results: 3 files / 23 tests passed for the Application policy core; 4 files / 22 tests passed for PostgreSQL and Runtime RPC; 1 real daemon/MCP scenario passed.

## Verified behavior

| Boundary                      | Evidence                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Closed schema                 | Runtime RPC rejects an Actor without the required canonical capability list as `INVALID_REQUEST` before invoking a gateway operation.                                                                               |
| Capability before side effect | A Human RPC Actor lacking `terminal.input` receives `POLICY_DENIED`; PostgreSQL contains no Action for that idempotency key and the sentinel bytes are absent from the PTY-facing input and durable audit payloads. |
| Capability and policy compose | Canonical Human/Agent profiles still pass the existing four-mode Input Policy and short Guard matrix; a capability never bypasses `human_only`, `agent_only`, or an active Guard.                                   |
| Process-local identity        | Reusing a live Actor id with a different client is rejected as `ACTOR_IDENTITY_CONFLICT` before interaction delivery.                                                                                               |
| Durable identity              | A second Session cannot reuse an existing Actor id with a changed principal. The transaction rolls back its Session reservation and leaves the original PostgreSQL Actor row and capability array unchanged.        |
| Historical attribution        | Event reads join and validate the persisted capability array; incomplete or non-canonical durable Actor data fails closed instead of returning an invented identity.                                                |

## Not proven

- Runtime RPC Actor authentication. The current local protocol still accepts the capability-bearing Actor asserted in the request body; ADR-0048 must bind it to an unforgeable, scoped grant.
- Capability enforcement for read, root Session create, close, dispatch, or wait operations, which do not yet carry authenticated caller context.
- Approval decisions, Approval expiry/use, Human-only secret input, or sensitive-period output redaction.
- Hostile code running with the same OS user's ability to read local credentials; capability policy is not an OS sandbox.
- Remote transport security, multi-user isolation, cross-host authorization, or repository-wide release L4.
