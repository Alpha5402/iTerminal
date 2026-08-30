# M6.3 bounded screen synchronization verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real node-pty/zsh, Runtime-owned headless ANSI/VT screen, Unix RPC, official MCP SDK client, terminal-cell region reads, retained row diffs, and explicit full-snapshot resync).** `screen_region` reads one exact active-viewport rectangle. `screen_diff` either returns bounded row replacements from a retained revision or states that a full resync is required.

This proves a bounded local synchronization primitive. It does not prove WebSocket subscriptions, Human Console reconnect, durable screen resume, rich cell/style parity, resize ownership, or the M6 L3 shared path.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- Shell path: real persistent zsh under node-pty
- Terminal emulator: exactly pinned `@xterm/headless` 6.0.0
- Geometry: canonical 120 columns × 40 rows
- Client path: official MCP TypeScript SDK v2 client → stdio bridge → Unix Runtime RPC → live Runtime projection

## Commands and results

```bash
pnpm exec vitest run packages/terminal-screen/src/index.test.ts packages/runtime-rpc/src/index.test.ts apps/mcp/src/screen-observation.test.ts apps/mcp/src/mcp-stdio.test.ts
pnpm verify
```

- M6 projection, RPC, and real MCP integration: 4 test files passed, 14 tests passed.
- Full repository gate: 11 test files passed, 40 tests passed, 12 environment-gated files skipped; format, lint, typecheck, 18-report verification gate, and build passed.

## Proven scenarios

| Scenario                  | Result                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Parser-complete revisions | A revision enters history only after the xterm parser callback applies its complete PTY chunk                              |
| Bounded revision history  | The projection retains a configurable test ring and a fixed production default of 64 revisions                             |
| Terminal-cell region      | A two-row rectangle returns only the requested cell columns and the exact current frame version                            |
| Wide-glyph boundaries     | A complete CJK glyph is preserved; a leading continuation or trailing clipped half is represented as blank space           |
| Retained row diff         | A retained base version returns only changed full rows plus current cursor, buffer, dimensions, and version                |
| No-change diff            | Diffing the current version returns zero changed rows while preserving current frame metadata                              |
| Evicted revision          | A base removed from the bounded ring returns `history_unavailable` and the current full resync snapshot                    |
| Future revision           | A version newer than live state returns `future_version` and the current full resync snapshot                              |
| Rectangle validation      | A region crossing row or column bounds returns `INVALID_REQUEST` instead of truncating silently                            |
| Exact generation          | A diff requested for a stale Session generation returns `SESSION_GENERATION_CHANGED`                                       |
| Official MCP path         | One real SDK client drives zsh, reads `screen_region`, applies `screen_diff`, and observes structured resync through stdio |

## Runtime contract

- Revision history is live process memory tied to one Session generation. It is not reconstructed from PostgreSQL Events.
- Each stored revision is one complete fixed-geometry active viewport after its `screenVersion` is applied.
- A non-resync diff contains at most 40 row replacements. Applying them and the returned frame metadata yields the current plain-text viewport.
- A resync result includes the current bounded full snapshot and never fabricates missing revisions.
- Region coordinates are zero-based terminal cells. Returned strings are right-trimmed and therefore are not fixed-length JavaScript strings.
- Full snapshots, regions, diffs, search results, and waits all share the same serialized parser boundary.

## Not proven

- Individual-cell/minimal edit scripts, style/color/underline metadata, hyperlinks, images, sixel, mouse modes, or pixel dimensions.
- Scrollback or durable Event diffing, durable snapshots, daemon-restart continuation, reconnect cursor persistence, or cross-owner transfer.
- WebSocket subscriptions, slow-consumer buffering, fan-out ordering, backpressure, live-gap UX, or Human Console resynchronization.
- Resize/reflow, geometry ownership, frontend xterm parity, or complex vim/nano/top/pager/psql/password fixture coverage.
- Input Guard/policy modes, TerminalState heuristics, secret redaction, Approval flow, multi-Worker fencing, cross-platform behavior, long soak, security review, L3 Human-Agent acceptance, or release readiness.
