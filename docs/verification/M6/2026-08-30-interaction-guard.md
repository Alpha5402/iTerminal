# M6.5 interaction policy and short Human Guard verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, node-pty/zsh, Unix Runtime RPC Human, official MCP SDK Agent, versioned policy/Guard state, guarded rejection, expiry, and policy-mode enforcement).** M6.5 prevents a competing Agent input batch while a short Human Guard is active, admits no rejected Action and performs no rejected PTY write, then restores progress after expiry.

This proves the backend/runtime/storage/RPC/MCP contract. It does not prove Human Console batching, browser/WebSocket behavior, full capability/Approval policy, new-generation rebuild, multi-Worker fencing, or M6 L3 acceptance.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- pnpm: 10.33.2
- Database: PostgreSQL 17.11, disposable `iterminal_test`, tmpfs-backed, bound to `127.0.0.1:55432`
- Shell path: real persistent zsh under node-pty
- Agent path: official MCP TypeScript SDK v2 client → stdio bridge → Unix Runtime RPC → Runtime
- Human path: `UnixRuntimeClient` with an explicit Human Actor → the same Runtime and PTY

The database suite refuses to mutate any database whose name is not exactly `iterminal_test`. The test workspace, Unix socket, PTY, and database storage are disposable. Rejection audit assertions use a sentinel and prove raw rejected input is absent from persisted Event payloads.

## Commands and results

```bash
pnpm typecheck
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test pnpm test:m6:interaction
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test pnpm test:m2
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test pnpm test:m4:durable
pnpm vitest run packages/runtime-rpc/src/index.test.ts apps/mcp/src/mcp-stdio.test.ts
pnpm verify
```

- M6.5 focused suite: 3 test files passed, 7 tests passed.
- M2 PostgreSQL admission regression: 1 test file passed, 7 tests passed.
- M4 durable Runtime/SIGKILL regression: 1 test file passed, 2 tests passed.
- Unix RPC/MCP compatibility suite: 2 test files passed, 5 tests passed.
- Full repository gate: 12 test files passed, 46 tests passed, 14 environment-gated files/41 tests skipped; format, lint, typecheck, 20-report verification gate, and build passed.

The M4 child-daemon check also exposed a Node.js 24 CommonJS/ESM interop failure in the pinned `@xterm/headless` import. The adapter now consumes the package's default CommonJS namespace while keeping named imports type-only; its 8 focused projection tests and the real child-daemon SIGKILL scenario pass.

## Proven scenarios

| Scenario                   | Result                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Default state              | Every created generation has `human_guarded`, version 1, and no Guard in live Runtime and PostgreSQL           |
| Version CAS                | Two durable mutations using expected version 1 have exactly one winner; state and Event commit atomically      |
| Constraint rollback        | A Guard renewal above its cap violates the schema and leaves both state version and Event stream unchanged     |
| Human Guard                | Human acquires a 150 ms Guard while a real Python foreground Execution is RUNNING                              |
| Agent rejection            | Official MCP Agent receives retryable `INPUT_GUARDED`; no Action row or PTY input is created                   |
| Holder progress            | Exact Human holder sends input to the same Python Execution while the Guard is active                          |
| Lazy expiry                | First post-TTL read clears the Guard, increments version, and emits exactly one `interaction.guard_expired`    |
| Mode matrix                | `human_only` denies Agent, `agent_only` denies Human and admits Agent, then `common` restores shared admission |
| Emergency Control boundary | L1 proves another Human can bypass only an active Guard; bypass cannot override `agent_only` policy            |
| Renewal bound              | L1 proves three renewals succeed, the fourth is denied, and expiry never leaves a permanent lock               |
| Idempotent accepted replay | A previously accepted Input replay returns the original Action even after policy later becomes `human_only`    |
| Rejection privacy          | Durable rejection metadata contains policy/Guard evidence but not the rejected raw input sentinel              |
| MCP observation            | `interaction_get` exposes policy, version, holder metadata, and expiry without exposing Human mutation tools   |

## Runtime contract

- Interaction policy/Guard state belongs to one Session generation and advances by expected-version CAS.
- Input/Control replay is checked before current policy so later policy changes do not rewrite accepted history.
- New interaction admission validates generation, active Execution, optional screen version, policy, and active Guard before allocating an Action sequence.
- PostgreSQL rechecks policy and non-expired Guard while holding the Session and interaction-state rows.
- `bypassGuard` is persisted on ControlAction. Only Human Control may use it, and it cannot bypass policy or stale-target checks.
- Guard expiry is request/read-driven and evented once; no permanent timer, takeover state, or automatic PTY replay exists.

## Not proven

- Human Console command composer/raw-key aggregation, HTTP/WS Guard mutation, disconnect/blur release, visual policy state, or browser L3 collaboration.
- Full capability storage, authenticated Human/System policy administration, Approval, secret-input channel, redaction during sensitive screens, or hostile local-client security.
- Cross-process concurrent policy mutation beyond PostgreSQL row CAS, M9 routing/fencing, stale-owner rejection, asymmetric partitions, or long soak.
- Rebuild/new-generation creation is M7 work; this run does not prove old Guard isolation across a completed rebuild flow.
- Guard behavior for every TUI/REPL, cross-platform clock skew, suspend/resume, macOS/Linux parity, or release readiness.
