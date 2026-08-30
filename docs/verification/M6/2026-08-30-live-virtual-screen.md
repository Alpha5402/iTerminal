# M6.1 live Virtual Screen verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real node-pty/zsh, pinned headless ANSI/VT parser, Runtime RPC, official MCP SDK client, alternate screen, Unicode/wide characters, cursor movement, and screen-version guarded input).** One Runtime-owned projection consumes the same visible PTY output as the Event path. `screen_get` returns a bounded fixed-geometry snapshot only after every earlier parser write completes.

This proves the first live full-viewport projection slice. It does not prove screen diff/region/search/wait, resize/reflow, styled cells, durable screen reconstruction, a Human Console, or full interactive TUI compatibility.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- Shell path: real persistent zsh under node-pty
- Terminal emulator: exactly pinned `@xterm/headless` 6.0.0
- Geometry: canonical 120 columns × 40 rows, matching the PTY spawn contract
- MCP path: official TypeScript SDK v2 client → stdio bridge → Unix Runtime RPC → live Runtime projection

`@xterm/headless` marks the headless buffer reader as proposed API. The flag is enabled only inside `@iterminal/terminal-screen`; domain, Application, RPC, and MCP contracts do not import xterm types. Any dependency upgrade must rerun the deterministic projection and real MCP scenarios.

## Commands and results

```bash
pnpm exec vitest run packages/terminal-screen/src/index.test.ts apps/mcp/src/mcp-stdio.test.ts
pnpm verify
```

- Virtual Screen unit projection plus real MCP integration: 4 tests passed.
- Full repository gate: 10 test files passed, 33 tests passed, 12 environment-gated files skipped; format, lint, typecheck, verification-report gate, and build passed.

## Proven scenarios

| Scenario                       | Result                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Serialized parser boundary     | Writes and snapshots share one promise lane; a read between queued writes captures exactly the earlier complete output prefix               |
| Split escape sequence          | `CSI` bytes split across two writes are parsed as one erase command instead of leaking raw escape text                                      |
| Cursor-addressed erase         | Absolute cursor movement and line erase replace the targeted row and report the resulting zero-based cursor                                 |
| Canonical wrapping             | A line wider than 120 columns wraps into the next 120×40 viewport row                                                                       |
| Unicode/wide characters        | CJK and emoji survive projection without byte corruption                                                                                    |
| Alternate screen               | `DECSET 1049` switches the reported active buffer; `DECRST 1049` restores the prior normal viewport                                         |
| Exact generation               | `screen_get` with a stale generation returns `SESSION_GENERATION_CHANGED`                                                                   |
| Version consistency            | A quiet completed screen snapshot has the same version exposed by `session_get`                                                             |
| Human/Agent freshness conflict | Agent reads alternate screen; a Human Actor changes it through Runtime RPC; Agent input guarded by the old version returns `SCREEN_CHANGED` |
| Fresh guarded retry            | Agent rereads the screen and uses its new version to let the live zsh command exit and restore the normal buffer                            |
| Bounded response               | Every full snapshot contains exactly 40 plain-text rows and no scrollback transcript                                                        |

## Runtime contract

- `TerminalScreenProjection` is an Application port; the xterm adapter is replaceable and independently testable.
- The projection is created before PTY startup so shell initialization output is not missed.
- `screenVersion` remains the Runtime's monotonically increasing visible-output version and is applied to the projection after parsing that output chunk.
- A snapshot includes Session ID/generation, version, geometry, active buffer, cursor, and trimmed plain-text rows.
- Closing the Session disposes its projection. A daemon restart does not reconstruct a lost live PTY or claim the old screen is current.

## Not proven

- Color/style attributes, hyperlinks, underline variants, images, sixel, mouse modes, clipboard sequences, or pixel/cell dimensions.
- Screen diff, region reads, search, scrollback queries, stable/text/version/exit waits, subscriptions, or cancellation semantics.
- Runtime resize/reflow, canonical-geometry ownership changes, multiple viewers, or frontend xterm parity.
- Durable `screen_snapshots`, restart resynchronization, retention, compression, artifact spillover, or replay from Event history.
- Complex TUI fixture matrix such as vim, nano, top, pagers, psql, password prompts, nested ssh/su/docker exec, or shell switching.
- Human/Agent concurrent input guard, policy modes, secret redaction, Approval flow, Human Console, accessibility, or the M6 L3 exit gate.
- Cross-platform terminal behavior, long soak, fuzzing, resource exhaustion, security review, or release readiness.
