# M7.1 versioned Shell Checkpoint and Session fork verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real local bash/zsh PTYs, independent child PTYs, official MCP SDK over stdio/Unix Runtime RPC, and PostgreSQL 17 checkpoint/lineage/idempotency storage).** READY, RUNNING, and same-owner BROKEN parents rebuild children from exact versioned checkpoints while cwd, Shell, and operator-allowlisted environment remain bounded and explicit.

This is a deterministic Runtime/adapter/storage claim, not the full M7 L3 Exit Gate. It proves same-live-owner rebuild and durable rows; it does not prove Browser Human UX, historical Session hydration in a new daemon, cross-owner routing/fencing, autonomous-model decisions, or release readiness.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- pnpm: 10.33.2
- Shells: real persistent bash and zsh under node-pty
- Agent path: official MCP TypeScript SDK v2 client → stdio bridge → Unix Runtime RPC → Runtime/PTY
- Database: PostgreSQL 17 Alpine, disposable `iterminal_test`, tmpfs-backed, bound to `127.0.0.1:55432`
- Checkpoint policy fixture: exact `ITERM_M7_SAFE` allowlist; non-allowlisted `UNLISTED_SECRET` is neither persisted nor restored

Database suites refuse to mutate any database whose name is not exactly `iterminal_test`. Test workspaces, Unix sockets, PTYs, PostgreSQL storage, and child Sessions are disposable.

## Commands and results

```bash
pnpm exec vitest run packages/application/src/runtime-durability.test.ts --maxWorkers=1
pnpm exec vitest run apps/mcp/src/session-fork.test.ts apps/mcp/src/mcp-stdio.test.ts
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm test:m7:fork
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
  packages/persistence-postgres/src/postgres-runtime-repository.test.ts \
  packages/persistence-postgres/src/postgres-terminal-geometry.test.ts \
  apps/runtime-daemon/src/durable-runtime.test.ts \
  apps/runtime-daemon/src/interaction-policy.test.ts \
  apps/runtime-daemon/src/resize.test.ts \
  apps/runtime-daemon/src/session-fork-durable.test.ts
pnpm verify
```

- Fork pre-admission rollback regression: 1 test file passed, 6 tests passed.
- Unified M7.1 Shell/Application/MCP/PostgreSQL suite: 4 test files passed, 17 tests passed.
- Official MCP fork + MCP tool-surface regression: 2 test files passed, 3 tests passed.
- Focused PostgreSQL fork suite: 1 test file passed, 1 test passed.
- Serialized affected PostgreSQL regression: 6 test files passed, 14 tests passed.
- Full repository gate: 19 test files / 76 tests passed; 17 environment-gated files / 45 tests skipped; 24 milestone reports verified; TypeScript, ESLint, Prettier, and production build passed.

The production build retained the existing Vite advisory for one 539.11 kB minified Console chunk. It is a bundle-optimization warning, not a build failure. The first full-gate attempt also exposed a pre-existing M6.7 password fixture race: its visible prompt preceded `stty -echo`. The fixture now disables echo before printing and polls the advisory state; its focused 2-test file and the final full gate pass.

The affected database files deliberately use one Worker because they migrate and truncate the same disposable database. A parallel exploratory invocation produced PostgreSQL DDL/TRUNCATE deadlocks; the serialized command is the valid isolated evidence path and passed.

## Proven scenarios

| Scenario             | Result                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| READY checkpoint     | Initial READY creates version 1; a completed command advances to version 2; READY fork re-certifies version 3 before child admission                                                                                  |
| Filtered environment | Shell Integration emits only exact allowlisted keys; public metadata exposes names but never values; non-allowlisted values are absent, and allowlisted multiline values are omitted rather than normalized or copied |
| Child restoration    | Real bash/zsh children start in the canonical parent cwd with the allowlisted value and same Shell/workspace                                                                                                          |
| Explicit non-copy    | Parent alias and unlisted env do not exist in the child; result limitations state that process, REPL/editor, implicit Shell state, and filesystem isolation are not copied                                            |
| Busy parent          | RUNNING parent remains RUNNING while a child uses its last READY checkpoint; omission of `allowStale` returns `CHECKPOINT_STALE`                                                                                      |
| Broken parent        | A same-owner BROKEN parent rebuilds a usable child from the last completed checkpoint without reviving the old PTY                                                                                                    |
| Version CAS          | Wrong client version or a conflicting locked PostgreSQL version/hash returns `CHECKPOINT_CHANGED`, advances no in-memory checkpoint, and creates no child/fork row                                                    |
| Invalid cwd          | A removed checkpoint cwd returns `CHECKPOINT_INVALID`; Runtime never falls back to workspace root and parent state remains unchanged                                                                                  |
| Idempotency          | Identical Actor/key/request returns the same child with `replayed: true`; changed payload under the same key returns `IDEMPOTENCY_KEY_REUSED`                                                                         |
| Durable lineage      | PostgreSQL stores parent Session/generation, checkpoint version/hash, child Session ID, Actor, READY fork status, and child lineage columns                                                                           |
| Attribution          | Parent durable stream contains Actor-attributed `session.fork_requested` then `session.forked`; child has normal create/start/ready lifecycle                                                                         |
| MCP boundary         | `session_checkpoint` and `session_fork` are registered through the official SDK; descriptions require CAS/stale acknowledgement and enumerate non-copied state                                                        |

## Architecture boundary verified

- READY facts come from the independent Shell Integration FIFO, not prompt text or parsed command strings.
- Checkpoint capture does not copy the host/Runtime environment wholesale. The daemon passes an exact bounded key allowlist to the Shell profile.
- Cwd and workspace are canonicalized with `realpath`; child cwd must remain the workspace itself or a descendant. This validates reconstruction and does not sandbox later commands.
- Content hash covers canonical workspace/cwd, Shell, and sorted filtered environment; version/observed time express observation order separately.
- Request-side parent mutations share one Runtime lane. Fork freezes the selected parent status/checkpoint, and PostgreSQL locks and compares both status plus checkpoint version/hash; an asynchronous lifecycle transition crossing admission is rejected instead of being reclassified.
- A child owns a new Session ID, generation 1, PTY, Shell, screen, policy, and Guard. Parent and child share only workspace files plus listed checkpoint context.
- PostgreSQL migration 006 stores immutable child lineage and an Actor-scoped fork idempotency record. It does not claim that a persisted PTY can migrate or resume.

## Not proven

- Browser Human checkpoint inspection, stale warning, fork/rebuild controls, accessibility, cross-browser behavior, or the full M7 L3 user path.
- Loading a historical READY/BROKEN parent and checkpoint into a fresh daemon after owner loss; M7.1 rows survive, but live routing hydration remains M7.2.
- Cross-owner replay, concurrent multi-Worker admission, Lease/Fencing, remote Runtime routing, or old PTY migration.
- Full secret classification/redaction. Exact operator allowlisting can still persist a sensitive value under an innocuous name; M10 security review remains required.
- Arbitrary non-newline control-byte environment values, locale/profile managers, user rc sourcing, aliases/functions/traps, background jobs, REPL transactions, editor buffers, descriptors, sockets, or filesystem snapshots.
- Git worktree isolation, filesystem conflict prevention, rollback, long-soak fork storms, performance/capacity budgets, packaging, or release readiness.
