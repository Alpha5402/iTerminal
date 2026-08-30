# M7.2 durable historical rebuild through Human Console verification — 2026-08-30

## Claim and level

**Result: PASS at L3 (real headless Chrome Human Console → loopback HTTP → Unix Runtime RPC → fresh same-owner daemon projection → PostgreSQL 17 checkpoint → new real zsh PTY).** A Human can inspect a durable historical `BROKEN` parent, see the explicit non-copy boundary, acknowledge stale context, rebuild a new Session, and run `git status` in the restored cwd/environment while the parent remains `BROKEN`.

This closes the M7.2 same-owner Human rebuild path. It does not upgrade autonomous-model use, cross-owner routing/fencing, actual old-PTY migration, or release readiness to L3/L4. The earlier M7.1 report remains the evidence for official MCP, bash/zsh, busy-parent, CAS, and invalid-cwd behavior.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- pnpm: 10.33.2
- Browser: installed Google Chrome, driven headlessly with `playwright-core` 1.62.1
- Console: production Vite build, loopback-only Fastify HTTP/WebSocket adapter
- Runtime: two sequential same-owner Runtime daemon instances connected through distinct Unix sockets
- Shell: new real persistent zsh/PTY after rebuild
- Database: PostgreSQL 17 Alpine, disposable `iterminal_test`, tmpfs-backed, bound to `127.0.0.1:55432`
- Checkpoint policy fixture: exact `ITERM_M7_SAFE` allowlist

The database suites refuse to mutate a database whose name is not exactly `iterminal_test`. Workspaces, sockets, Sessions, PTYs, browser state, and PostgreSQL storage are disposable.

## Commands and results

```bash
pnpm exec vitest run apps/console/src/server.test.ts

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run apps/runtime-daemon/src/session-rebuild-durable.test.ts

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm test:m7:rebuild:browser

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm test:m7:fork

pnpm verify
git diff --check
```

- Console HTTP/WebSocket adapter: 1 file / 3 tests passed.
- Fresh-daemon durable projection: 1 file / 1 test passed.
- Targeted production-build Browser Human rebuild: 1 test passed / 2 unrelated Browser tests skipped.
- Unified M7 regression: 6 files / 21 tests passed.
- RPC disconnect regression after the full-gate finding: 2 files / 8 tests passed.
- Final full repository gate: 19 files / 77 tests passed; 18 environment-gated files / 47 tests skipped; 25 milestone reports verified; Prettier, ESLint, TypeScript, and production build passed.

The production Console build retained the existing advisory for a 542.81 kB minified JavaScript chunk. It is a bundle-optimization warning, not a build failure.

Red exploratory runs are retained in the work record: the first sandboxed Console and full-repository runs failed before affected tests because Unix Socket/loopback listen was denied with `EPERM`; the first fresh-daemon test used a path above the macOS Unix Socket length limit and failed with `EINVAL`; the first static gate found and removed one unnecessary type assertion. A subsequent full run passed every assertion but exposed an unhandled response-side `EPIPE` when a client disconnected during RPC work. The server now consumes connection-scoped socket errors and skips responses to destroyed/non-writable sockets; its 8-test RPC/Console regression and the final full gate pass.

## Proven scenarios

| Scenario               | Result                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner reconciliation   | Replacement daemon marks the prior same-owner durable generation `BROKEN` and hydrates it into bounded memory routing                                             |
| No fake live state     | Historical parent has no active Execution; `screen.get` returns `SESSION_BROKEN`; Console does not open its live screen WebSocket                                 |
| Checkpoint inspection  | Human sees exact version, BROKEN source, age, canonical cwd, allowlisted key names, and no environment values                                                     |
| Explicit limitations   | UI states that new PTY creation does not copy processes, REPL/editor/vim memory, jobs, aliases, functions, traps, sockets, or descriptors                         |
| Stale acknowledgement  | Rebuild control is disabled until the Human explicitly acknowledges the last completed READY boundary                                                             |
| Idempotent Human write | HTTP fork uses the cookie-bound Human Actor, exact checkpoint version, and a stable per-checkpoint retry key                                                      |
| New Session/PTY        | Success selects a distinct READY Session ID/generation 1 with immutable parent/checkpoint lineage                                                                 |
| Reconstructed context  | Child starts at the historical subdirectory with the allowlisted environment and successfully runs `git status`, `pwd`, and environment output in real zsh        |
| Parent truth           | PostgreSQL and Runtime retain the historical parent as `BROKEN`; no code path changes it to READY or binds the child PTY to the old ID                            |
| Durable attribution    | `session_forks.actor_id` is the server-created `human_console_*` Actor and records exactly one child                                                              |
| Bounded projection     | PostgreSQL query is owner-scoped, exact-generation/checkpoint scoped, ordered newest-first, and capped at 100; malformed or current-policy-incompatible rows skip |

## Architecture boundary verified

- PostgreSQL supplies durable accepted/observed facts and reconstruction context, not a live PTY.
- Hydration constructs only a `BROKEN` Session/checkpoint projection. It creates no Executor, screen, Interaction Guard, active Execution, or READY state.
- The same `session_fork` CAS/idempotency/lineage path handles live and historical parents; there is no privileged rebuild bypass.
- Filesystem `realpath`/containment validation occurs at explicit fork time. Missing historical paths remain visible evidence but cannot silently fall back to workspace root.
- Current operator environment policy is re-applied before hydration; an older broader checkpoint cannot bypass the replacement daemon's allowlist.
- Historical Timeline reads durable Events and bounds the visible tail to 500 entries.

## Not proven

- A separate operating-system daemon process terminated by actual `SIGKILL` during this specific Browser scenario. M4 separately proves process-crash reconciliation; this M7.2 fixture injects owner loss and starts a fresh daemon instance deterministically.
- Cross-owner hydration, competing owners, Lease/Fencing, remote routing, multi-Worker takeover, or any migration/resurrection of the old PTY.
- More than the newest 100 historical rebuild projections, archival browsing/search UX, retention/GC, or capacity under a fork/rebuild storm.
- Automatic recovery. Rebuild intentionally requires a Human/Agent request, exact checkpoint version, and stale acknowledgement.
- Process, foreground program, REPL/editor/vim state, jobs, aliases/functions/traps, sockets, file descriptors, transactions, or filesystem snapshots.
- Secret-channel safety beyond exact allowlisting. An operator can still allowlist a sensitive value under an innocuous name; M10 review remains required.
- Firefox/Safari, accessibility audit, mobile/responsive UI, style/pixel parity, localization, packaging, long soak, or release readiness.
- Autonomous model selection of checkpoint/fork actions or the full project L4 gate.
