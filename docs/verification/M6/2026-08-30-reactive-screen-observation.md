# M6.2 reactive screen observation verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real node-pty/zsh, Runtime-owned headless ANSI/VT screen, Unix RPC, official MCP SDK client, bounded viewport search, reactive waits, structured timeout, and RPC disconnect cancellation).** `screen_search` reports literal matches against one exact current-viewport snapshot. `screen_wait` observes parser-applied screen versions or an exact Execution completion without application-level polling.

This proves a bounded local observation slice. It does not prove prompt/readiness detection, screen diff/region reads, scrollback search, durable waits across daemon restart, subscription delivery, Human Console resynchronization, or M6 L3 concurrency safety.

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

- M6.2 projection, RPC, and real MCP integration: 4 test files passed, 11 tests passed.
- Full repository gate: 11 test files passed, 37 tests passed, 12 environment-gated files skipped; format, lint, typecheck, 17-report verification gate, and build passed.

## Proven scenarios

| Scenario                  | Result                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Current viewport search   | Case-sensitive or insensitive literal search returns bounded matches and never scans scrollback or durable Events            |
| Terminal-cell coordinates | Search maps a CJK wide character to its two-cell span instead of reporting JavaScript string offsets                         |
| Bounded result            | `maxMatches` caps output and `truncated` reports that another visible match exists                                           |
| Version wait              | Parser callback notification resolves only after `screenVersion` is applied and returns that exact snapshot                  |
| Visible-text wait         | Official MCP client blocks until literal text appears in the active viewport                                                 |
| Stable interval           | No applied screen-version change for the requested interval satisfies stability; the contract does not infer Shell readiness |
| Exact Execution exit      | Wait validates Session/generation ownership and returns the terminal Execution together with the latest snapshot             |
| Structured timeout        | An unsatisfied condition returns `matched: false`, `reason: "timeout"`, elapsed time, and the latest bounded snapshot        |
| Abort propagation         | Closing the Unix RPC client aborts the server-side wait instead of leaving it alive until its normal timeout                 |
| Projection lifecycle      | Abort, timeout, disposal, and parser failure remove or reject registered version waiters                                     |

## Runtime contract

- `TerminalScreenProjection.waitForVersion` registers against the serialized parser boundary; it does not run an interval polling loop.
- `screen_wait` accepts exactly one of text, version, stable interval, or Execution terminal-state conditions and enforces a 1–300,000 ms timeout.
- Stable means only “no applied `screenVersion` change”. Command completion still comes from Shell Integration/Execution state.
- Search and wait are exact-generation live operations. They return no durable-resume token and make no survival claim across Runtime restart.
- Search coordinates are zero-based terminal cells tied to the included snapshot and current active buffer.

## Not proven

- Regex, fuzzy, multiline, style-aware, semantic, OCR/image, scrollback, or durable Event search.
- Screen diff/region reads, styled cell metadata, hyperlinks, images, mouse modes, pixel dimensions, or screenshot protocols.
- Prompt detection, readiness inference, application-idle inference, TerminalState heuristics, or confidence/evidence classification.
- Durable waits, reconnect/resume cursors, subscription ordering/backpressure, multi-viewer fan-out, or Human Console resynchronization.
- Resize/reflow, geometry ownership, frontend xterm parity, or complex vim/nano/top/pager/psql/password fixture coverage.
- Input Guard/policy modes, secret redaction, Approval flow, multi-Worker fencing, cross-platform behavior, long soak, security review, L3 Human-Agent acceptance, or release readiness.
