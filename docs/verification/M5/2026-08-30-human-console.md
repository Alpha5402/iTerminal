# M5 Human Console shared-path verification — 2026-08-30

## Claim and level

**Result: PASS at L3 (real headless Google Chrome Human Console, official MCP SDK Agent, PostgreSQL 17, node-pty/zsh, and one shared Python REPL).** A browser Human and MCP Agent use different transports but act on one durable Session generation through the same Runtime/Application admission path. They share cwd, environment, foreground process, canonical screen, Interaction Guard, and attributed Action timeline without a browser-side PTY write path.

This is an L3 shared-transport scenario, not an autonomous-model or release-readiness claim. The Agent is a deterministic official SDK client, while the Human path is exercised through a real browser DOM, keyboard events, HTTP, WebSocket, and xterm.js.

## Environment

- Host: macOS 26.5 / Darwin 25.5.0, arm64
- Node.js: 24.15.0
- pnpm: 10.33.2
- Browser: Google Chrome 152.0.7977.64, headless through Playwright Core
- Database: PostgreSQL 17, disposable `iterminal_test`, tmpfs-backed, bound to `127.0.0.1:55432`
- Shell path: real persistent zsh under node-pty
- Human path: Chrome → React/xterm.js → loopback Fastify HTTP/WS → Unix Runtime RPC → Runtime
- Agent path: official MCP TypeScript SDK v2 client → stdio MCP bridge → the same Unix Runtime RPC and Runtime

The database suite refuses to mutate any database whose name is not exactly `iterminal_test`. Test workspaces, Unix sockets, PTYs, browser context, and database storage are disposable.

## Commands and results

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test:m5
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  ITERM_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  pnpm test:m5:browser
pnpm vitest run packages/runtime-rpc/src/index.test.ts apps/console/src/server.test.ts
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test pnpm test:m6:interaction
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test pnpm test:m4:durable
pnpm verify
```

- Console HTTP/WS integration suite: 1 test file passed, 2 tests passed.
- Real browser shared-path suite: 1 test file passed, 1 test passed.
- Runtime RPC cancellation plus Console regression: 2 test files passed, 7 tests passed.
- M6.5 Guard regression: 3 test files passed, 7 tests passed.
- M4.1 durable Runtime/SIGKILL regression: 1 test file passed, 2 tests passed.
- Full repository gate: 13 test files/49 tests passed; 15 environment-gated files/42 tests skipped; format, lint, typecheck, 21-report verification, TypeScript build, and Vite production build passed.
- The production bundle completed with one advisory warning: its 537.13 kB minified JavaScript chunk exceeds Vite's 500 kB warning threshold. No performance or bundle-budget claim is made.

## Proven scenarios

| Scenario                  | Result                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human identity            | Server issues an HttpOnly, SameSite cookie and maps it to a bounded process-local Human Actor; the page does not choose its actor identity                        |
| Network boundary          | Server rejects non-loopback binding, untrusted Host/Origin, and missing mutation headers; MCP remains stdio-only                                                  |
| Session creation          | Browser creates one persistent zsh Session through the Application/Runtime path and observes READY                                                                |
| READY contract            | Browser composer changes cwd and exports an environment variable; raw Input is rejected while no Execution is RUNNING                                             |
| Shared foreground process | Official MCP Agent starts `python3 -q`; the browser observes RUNNING and enters interactive focus                                                                 |
| Human input batching      | A 5 ms inter-key fixture forces multiple 20 ms InputAction batches targeted at the exact Execution/generation; Human echo does not create a self-stale screen CAS |
| Guard arbitration         | Browser Human acquires the generation-scoped Guard; a racing MCP Agent input gets `INPUT_GUARDED` and creates no Action                                           |
| Progress after release    | Idle Human Guard release converges, then the Agent reads the Human-created Python variable, prints `42`, and exits                                                |
| Shared Shell state        | Browser composer subsequently observes the cwd and environment value established before the Agent-owned Python Execution                                          |
| Durable attribution       | PostgreSQL contains Human and Agent Actions; the guarded rejected idempotency key has no accepted Action row                                                      |
| Browser resume            | Reload reconnects using saved cursor/screen state, restores the canonical screen, and rebuilds the attributed Timeline                                            |
| Slow/gapped live stream   | WebSocket payloads are bounded; event/screen gaps explicitly force durable event catch-up and full screen resynchronization                                       |
| Disconnect cleanup        | Last browser stream close attempts Guard release, while finite TTL remains the correctness fallback if release cannot arrive                                      |

## Architecture boundary verified

- The Console server owns HTTP/WS presentation concerns only; it has no node-pty dependency and cannot obtain a PTY handle.
- Every Human Execute/Input/Control operation crosses `RuntimeGateway`, preserving generation, target Execution, idempotency, policy, Guard, Action, and Event checks.
- WebSocket data is a resumable projection, not a second truth store. Durable events and the current canonical screen repair reconnect gaps.
- READY command composition and RUNNING raw interaction are separate modes. Neither UI focus nor terminal quietness is treated as prompt readiness.
- The canonical viewport stays 120×40 in this milestone. Independent viewers do not resize or own terminal geometry.

## Not proven

- A real LLM autonomously deciding and executing the Agent workflow; this run uses a deterministic official MCP SDK client and does not authorize external model calls.
- Linux, Windows, Safari, Firefox, mobile, remote access, hostile multi-user authentication, TLS, CSRF beyond the local Origin/Host/mutation boundary, or Internet exposure.
- Multiple simultaneous browser writers under sustained load, browser crash during every Guard lifecycle edge, OS suspend/resume, long soak, or performance/capacity targets.
- Frontend code splitting, a production bundle budget, load time, memory usage, or low-powered-device performance; the current Vite chunk warning remains open.
- Controlled resize/reflow, browser/headless style-cell parity, hyperlink/image/mouse metadata, every TUI/REPL, terminal-state heuristics, or daemon-restart durable wait subscriptions.
- Session rebuild/fork, Approval UI, secret-input channels, redaction, workspace containment, capabilities, quotas, audit export, M9 fencing, multi-Worker ownership, packaging, or release readiness.
