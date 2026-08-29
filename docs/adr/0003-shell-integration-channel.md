# ADR-0003: Out-of-band Shell Integration control channel

- Status: Accepted for M0; production adapter remains an M1 gate
- Date: 2026-08-30

## Context

The Runtime must observe top-level command start, completion, exit code, Shell readiness, and cwd without wrapping commands in a subshell or guessing prompts/quiet periods.

Markers mixed into PTY output can be displayed, fragmented, or forged by normal command output. Shell-specific hooks also behave differently in bash and zsh.

## Decision

Prefer a separate local control channel from Shell hooks to Runtime. The M0 implementation tests a POSIX FIFO with NUL-framed fields:

```text
HELLO   NUL shell NUL pid NUL
PREEXEC NUL shell-command NUL empty NUL
RESULT  NUL exit-code NUL empty NUL
READY   NUL prompt-exit-code NUL cwd NUL
```

The Runtime owns the pending Action ID; it does not inject the ID into user commands. It associates the first relevant PREEXEC/RESULT/READY sequence after dispatch with that pending Action. RESULT means the dispatch wrapper finished; READY independently proves that the interactive Shell returned to its prompt. If an interrupt prevents RESULT, READY's exit code is the fallback.

The M0 spike uses a private POSIX FIFO to prove physical separation and streaming behavior. The production design should use a close-on-exec control descriptor or equivalent supervisor channel so ordinary child processes do not inherit it. A nonce-authenticated OSC/DCS protocol remains a compatibility fallback, not the default. The comparison is recorded in [the control-channel compatibility matrix](../architecture/shell-integration-control-channel.md).

On macOS bash 3.2, interactive `eval` can print a syntax error and still return zero. Its adapter therefore uses the same `/bin/bash -n -c` as a syntax-only compatibility check before evaluating valid input in the persistent Shell. The checker does not execute valid Actions or carry runtime state.

## M0 evidence

- bash and zsh preserve top-level `cd/export/source` state.
- Multiline input, syntax errors, nonzero exits, Ctrl+C, and large output close correctly.
- PTY output that looks like a marker cannot close an Execution.
- Arbitrary stream chunking cannot corrupt the control parser.
- Managed-profile bash 3.2.57 and zsh 5.9 pass the L2 spike report.
- User rc/prompt compatibility remains an explicit M1/CI matrix gate; M0 does not claim it.

Evidence: [2026-08-30 Shell Integration spike](../verification/M0/2026-08-30-shell-integration.md).

## Known trust boundary

Code running as the same OS user may deliberately discover and attack local Runtime resources. Shell Integration prevents accidental PTY-marker spoofing; it is not an OS sandbox.
