# M0 Shell Integration verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (component/runtime spike).** A real local PTY with a real persistent bash or zsh preserved Shell state and produced out-of-band command lifecycle evidence. This is not an L3 Human Console/MCP path and not production-runtime acceptance.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- pnpm: 10.33.2
- bash: GNU bash 3.2.57(1)-release
- zsh: 5.9
- node-pty: 1.2.0-beta.12
- Shell startup: Runtime-managed profiles; user rc files intentionally excluded

`node-pty` is pinned to 1.2.0-beta.12 because the 1.1.0 macOS package can ship a non-executable `spawn-helper`; the upstream reports track the packaging defect and its beta fix: [issue 850](https://github.com/microsoft/node-pty/issues/850), [issue 919](https://github.com/microsoft/node-pty/issues/919).

## Commands and observed results

```bash
pnpm spike:shell -- --shell bash
pnpm spike:shell -- --shell zsh
```

Both commands exited 0. Each report passed these scenarios:

| Scenario                                                            | bash 3.2.57    | zsh 5.9        |
| ------------------------------------------------------------------- | -------------- | -------------- |
| `cd` then `pwd` shares cwd                                          | PASS           | PASS           |
| `export` then later read shares environment                         | PASS           | PASS           |
| Multiline input is one submitted Action boundary                    | PASS           | PASS           |
| `false` returns exit 1                                              | PASS           | PASS           |
| Syntax error returns nonzero and Shell returns READY                | PASS, exit 2   | PASS, exit 1   |
| PTY text resembling READY/ACTION_END/PREEXEC cannot close execution | PASS           | PASS           |
| 2,500-line output reaches final line                                | PASS           | PASS           |
| Ctrl+C interrupts the active execution                              | PASS, exit 130 | PASS, exit 130 |
| Shell state survives Ctrl+C                                         | PASS           | PASS           |

The control decoder unit fixture also covers frames split/coalesced across arbitrary chunks, marker-like PTY text, unknown frame types, and truncated frames.

The milestone quality gate also exited 0:

```bash
pnpm verify
```

It completed Prettier check, ESLint, TypeScript no-emit checking, Vitest (2 files, 5 tests), and the declaration/source-map build.

## Boundary observations

- PTY bytes are treated as one merged terminal stream; lifecycle frames never come from PTY text.
- Runtime correlates its pending Action ID with the next PREEXEC/RESULT/READY cycle instead of embedding IDs in the submitted command.
- RESULT captures wrapper completion; READY separately proves prompt readiness and cwd.
- The bash adapter syntax-checks through `/bin/bash -n -c` because macOS bash 3.2 interactive `eval` can report syntax errors with status zero.
- The spike uses a nonblocking FIFO reader to avoid shutdown hangs and bounds captured PTY output to 8 MiB.

## Not proven

- User rc/prompt frameworks, Linux matrix, descriptor hardening, reconnect, persistence, multi-worker ownership, MCP, and web UI.
- Security against malicious code running as the same OS user.
- L3/L4 end-to-end or user acceptance.

These gaps are retained in M1 and later milestones; they are not hidden by the M0 PASS.
