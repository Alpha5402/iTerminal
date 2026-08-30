# M6.6 controlled terminal geometry verification — 2026-08-30

## Claim and level

**Result: PASS at L3 (real headless Google Chrome Human Console, official MCP SDK Agent, PostgreSQL 17, node-pty/zsh, real `SIGWINCH`, and one Runtime-owned dynamic Virtual Screen).** Human and Agent independently resize the same Session generation through attributed ResizeActions, while one geometry-version CAS and one canonical screen keep their transports converged.

This is a deterministic shared-transport scenario, not an autonomous-model or release-readiness claim. It proves explicit resize and text-screen parity at the exercised geometries; it does not prove every TUI, browser, platform, style, pixel metric, or long-running concurrency pattern.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- pnpm: 10.33.2
- Browser: local Google Chrome, headless through Playwright Core
- Database: PostgreSQL 17, disposable `iterminal_test`, tmpfs-backed, bound to `127.0.0.1:55432`
- Shell path: real persistent zsh under node-pty
- Human path: Chrome → React/xterm.js → loopback Fastify HTTP/WS → Unix Runtime RPC
- Agent path: official MCP TypeScript SDK v2 client → stdio MCP bridge → the same Runtime

The database suites refuse to mutate any database whose name is not exactly `iterminal_test`. Test workspaces, sockets, PTYs, browser contexts, and database storage are disposable.

## Commands and results

```bash
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test pnpm test:m6:resize
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test pnpm test:m6:resize:browser
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test pnpm test:m6:interaction
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test pnpm test:m4:durable
pnpm vitest run apps/mcp/src/mcp-stdio.test.ts packages/runtime-rpc/src/index.test.ts apps/console/src/server.test.ts
pnpm verify
```

- M6.6 focused suite: 3 test files passed, 12 tests passed.
- Real browser shared-path suite: 1 test file passed, 2 tests passed.
- M6.5 interaction regression: 3 test files passed, 7 tests passed.
- M4 durable Runtime/SIGKILL regression: 1 test file passed, 2 tests passed.
- MCP/RPC/Console adapter regression: 3 test files passed, 8 tests passed.
- Full repository gate: 14 test files/52 tests passed; 16 environment-gated files/44 tests skipped; format, lint, typecheck, 22-report verification gate, TypeScript build, and Vite production build passed.

The production Console build completes with an advisory JavaScript chunk-size warning above Vite's 500 kB threshold. This milestone makes no bundle-budget or frontend-performance claim.

## Proven scenarios

| Scenario                     | Result                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical owner              | One Runtime generation starts at 120×40/version 1; browser layout and reconnect never auto-fit or write node-pty geometry                                |
| Human resize                 | Browser form creates a Human ResizeAction from version 1, PTY becomes 96×30, Python receives and prints `SIZE=96x30`, and geometry advances to version 2 |
| Stale Agent CAS              | MCP Agent requests from version 1 after Human resize and receives retryable `GEOMETRY_CHANGED`; PostgreSQL contains no rejected/stale Action             |
| Agent resize                 | Agent re-observes version 2, resizes to 100×32, Python receives `SIGWINCH`, browser observes `SIZE=100x32`, and geometry advances to version 3           |
| Durable attribution          | PostgreSQL contains exactly one Human and one Agent ResizeAction; Session geometry is 100×32/version 3                                                   |
| Concurrent database CAS      | Two PostgreSQL admissions for geometry version 1 have exactly one winner, one Action/Event, and version 2                                                |
| Reflow                       | Headless parser reflows the cursor line at a smaller geometry and advances screen version in the same serialized projection lane                         |
| Cross-geometry diff          | A diff from the pre-resize screen returns `resyncRequired: true`, reason `geometry_changed`, and the current full snapshot                               |
| Dynamic bounds               | Regions/cells validate against execution-time live geometry and reject coordinates outside the resized viewport                                          |
| Browser/headless text parity | After both Human and Agent resize, browser xterm buffer text equals the Runtime headless screen text                                                     |
| Policy/Guard                 | A live Human Guard rejects Agent resize with `INPUT_GUARDED`; the exact Human holder can resize the same RUNNING PTY                                     |
| Unknown delivery             | Injected failure after real node-pty resize yields `DELIVERY_UNKNOWN`, Action `UNKNOWN`, Session `BROKEN`, and no automatic replay                       |
| Broken-generation audit      | Exact-generation Event queries remain readable after BROKEN so callers can reconcile `resize_write_attempted`, `resize_unknown`, and `session.broken`    |
| Browser Guard convergence    | A stale idle-release CAS refreshes interaction state and retries only an extant own Guard, avoiding an error overlay that blocks later Human actions     |

## Architecture boundary verified

- Runtime, not a viewer, is the only canonical geometry owner. Human and Agent are equal requesters, not terminal owners.
- Resize uses the same generation, idempotency, policy, Guard, durable acceptance, write-attempt, and unknown-delivery boundaries as other terminal mutations.
- PostgreSQL stores accepted desired geometry and attribution; it does not claim to reconstruct a live PTY after an uncertain attempt.
- Projection resize is queued before node-pty resize, so output caused by `SIGWINCH` is parsed against the new geometry.
- `geometryVersion` protects decisions about dimensions; `screenVersion` continues to protect visible-screen freshness. The two are deliberately not interchangeable.
- Browser xterm is a renderer of canonical snapshots. It does not call responsive fit logic or infer shared geometry from DOM size.

## Not proven

- Autonomous LLM choice of terminal dimensions, approval policy for resize, hostile-client authorization, remote authentication, or multi-tenant isolation.
- Firefox, Safari, Linux, Windows, mobile, multiple simultaneous browser windows, OS suspend/resume, or long-soak resize storms.
- Style-cell/pixel parity after resize, font metrics, mouse coordinates, hyperlinks, images/sixel, scrollback parity, or every alternate-screen TUI.
- Geometry recovery after daemon restart, live PTY migration, M9 fencing across multiple Runtime owners, or automatic reconstruction from PostgreSQL.
- Performance budgets, maximum-geometry sustained output, memory/copy cost, production bundle size, packaging, or release readiness.
