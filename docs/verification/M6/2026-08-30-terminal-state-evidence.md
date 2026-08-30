# M6.7 bounded terminal-state evidence verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real local bash/zsh PTYs and real REPL/editor/pager/monitor/confirmation/password-like programs observed through the official MCP SDK and Unix Runtime RPC).** The Runtime returns one exact-generation, read-only `TerminalStateObservation` whose authoritative facts, heuristic signals, confidence, and limitations remain explicit and bounded.

This is a deterministic adapter/Runtime scenario, not an autonomous-model or safety-authorization claim. It proves the exercised classifications and spoof boundaries; it does not prove foreground-process identity, terminal echo mode, every shell wrapper/TUI/prompt/locale, or that an Agent can safely act from a label.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- pnpm: 10.33.2
- Shells: real persistent bash and zsh under node-pty
- Programs: local `python3`, `vim`, `nano`, `less`, and `top`
- Agent path: official MCP TypeScript SDK v2 client → stdio MCP bridge → Unix Runtime RPC → live Runtime/PTY/Virtual Screen
- Storage mode: process-local in-memory Runtime; this read-only observation deliberately creates no Action/Event/snapshot persistence

Test workspaces, sockets, PTYs, and fixture files are disposable. The password-like fixture disables TTY echo, sends only a fixed test value, verifies that the value does not appear in the screen result, and records neither raw command nor screen content in `TerminalStateObservation`.

## Commands and results

```bash
pnpm test:m6:state
pnpm exec vitest run apps/mcp/src/mcp-stdio.test.ts packages/runtime-rpc/src/index.test.ts apps/mcp/src/screen-observation.test.ts
pnpm verify
```

- M6.7 classifier + real PTY/MCP suite: 2 test files passed, 7 tests passed.
- MCP/RPC/screen regression: 3 test files passed, 9 tests passed.
- Full repository gate: 16 test files/59 tests passed; 16 environment-gated files/44 tests skipped; format, lint, typecheck, 23-report verification gate, TypeScript build, and Vite production build passed.

The production Console build completes with an advisory JavaScript chunk-size warning at 539.11 kB, above Vite's 500 kB threshold. This backend/MCP milestone makes no new bundle-budget or frontend-performance claim.

The first sandboxed focused attempt could not bind its disposable Unix socket and failed with `listen EPERM`; the same exact command passed outside that filesystem/socket restriction. That failure is an execution-environment limit, not a product result.

## Proven scenarios

| Scenario                     | Result                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authoritative READY          | Real bash and zsh return `shell_ready/high` from `session.ready`; viewport text resembling `Password:`, `>>>`, and confirmation prompts cannot override it                     |
| Stable is not READY          | A real `sleep 30` reaches RUNNING and satisfies `screen_wait stable`, while `terminal_state` remains `running/high` with Session/Execution fact evidence                       |
| Python REPL                  | Real `python3 -q` returns `repl/medium` with command-family and viewport-prompt signals, then exits through structured Input                                                   |
| Editors                      | Real `vim` and `nano` return `editor/medium` from bounded command-family evidence without requiring implementation-specific screen text                                        |
| Pager                        | Real `less` returns `pager/medium` and exits through structured Input                                                                                                          |
| Monitor                      | Real `top` remains generic `running/high` while exposing a bounded `command.monitor_family` signal                                                                             |
| Confirmation                 | A shell read prompt returns `confirm/low` plus `screen_content_spoofable`; the label does not authorize sending `y` or Enter                                                   |
| Password-like prompt         | A real no-echo read returns `password/low`, `screen_content_spoofable`, and `terminal_echo_mode_unobserved`; the fixed fixture secret is absent from the screen result         |
| Conservative command parsing | Shell composition such as `vim file; sleep 30` is not treated as editor-family evidence                                                                                        |
| Exact generation             | A stale generation request fails with `SESSION_GENERATION_CHANGED` rather than classifying the current generation                                                              |
| Bounded result               | Result fields use closed enums, at most eight evidence/limitation items, an exact screen frame, and no raw command, screen lines, input, environment value, or inferred secret |
| Protocol regression          | Official MCP tool listing includes `terminal_state`; MCP stdio, Runtime RPC, and existing screen-observation suites remain green                                               |

## Architecture boundary verified

- Shell Integration Session/Execution state remains the authority for READY/RUNNING; the classifier does not guess a prompt or reconstruct process state.
- Command family, alternate-buffer state, and viewport markers are signals. Screen-derived password/confirmation labels remain low-confidence; editor/pager/REPL labels are at most medium-confidence.
- Every result is bound to the requested Session generation and one exact live screen frame (`screenVersion` and `geometryVersion` included); the read is serialized with Session mutations so its facts do not cross an Execute transition during capture.
- The Runtime classifier never shells out, evaluates a command, scans scrollback, or returns the command/transcript as evidence.
- `terminal_state` is read-only and is not included in delivery-unknown mutation handling. It does not create an Action or Event and does not mutate `session_snapshots`.
- Existing generation, Execution target, screen/geometry freshness, Input Policy, Interaction Guard, Approval, and Human decision requirements remain unchanged.

## Not proven

- Autonomous LLM behavior, safe automatic input/control, password/secret-channel activation, Approval decisions, authorization, command completion, or prompt readiness from TerminalState.
- Current foreground process identity, aliases/functions/wrappers/pipelines/nested interpreters, process-tree inspection, terminal echo-mode observation, or shell job-control reconstruction.
- Every editor, pager, REPL, TUI, localized prompt, theme, terminal protocol, macOS/Linux distribution, or Windows behavior.
- Durable TerminalState history, daemon-restart reconstruction, PTY migration, multi-owner M9 fencing, or cross-process observation continuity.
- Hostile output resistance beyond explicit confidence/limitations, secret redaction for general terminal output, production security review, performance/soak budgets, packaging, or release readiness.
