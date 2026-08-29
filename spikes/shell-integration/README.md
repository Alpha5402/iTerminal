# Shell Integration feasibility spike

This spike tests the highest-risk iTerminal claim before production architecture is built:

> Can bash and zsh expose reliable top-level execution boundaries over an out-of-band channel while preserving one real shared Shell state?

## Design under test

- `node-pty` owns one persistent interactive Shell.
- Shell hooks emit NUL-framed control events into a private POSIX FIFO; the spike polls its nonblocking read descriptor.
- PTY output and control events are physically separate streams.
- The Runtime owns the pending Action ID and associates the next PREEXEC/RESULT/READY cycle with it.
- A command is dispatched through the Shell `eval` builtin, not a subshell, so `cd`, `export`, and `source` mutate the persistent Shell.
- One dispatch wrapper groups multiline input into one Shell boundary.

Control frames:

```text
HELLO   NUL shell NUL pid NUL
PREEXEC NUL command NUL
RESULT  NUL exit-code NUL empty NUL
READY   NUL exit-code NUL cwd NUL
```

`RESULT` records the dispatch wrapper's exit code. `READY` independently proves that the
interactive Shell has returned to its prompt; its exit code is retained as the fallback when
an interrupt prevents the wrapper from emitting `RESULT`.

## Run

```bash
pnpm spike:shell -- --shell zsh
pnpm spike:shell -- --shell bash
```

The command runs shared cwd/env, multiline, nonzero, syntax error, marker spoof, large output, and interrupt scenarios. It prints one JSON report and exits nonzero if any scenario fails.

## Intentional limitations

- POSIX only: the control channel currently uses `mkfifo`.
- The spike FIFO path is available to same-user code through the Shell environment. This separates accidental output spoofing but is not a sandbox/security boundary.
- The `eval` dispatch wrapper is visible in raw PTY output. Production Human Console UX must render the submitted Action separately or use a reviewed dispatch protocol.
- bash DEBUG trap and zsh preexec/precmd are only tested against the recorded shell versions.
- macOS bash 3.2 interactive `eval` reports syntax errors but can return zero. The bash adapter
  therefore syntax-checks each submitted Action with the same `/bin/bash -n -c` before evaluating
  valid input in the persistent Shell. This checker is compatibility logic, not an execution shell.
- User rc files are not sourced in the spike; production startup profiles require separate compatibility evidence.
- The in-memory output capture is bounded for the spike and is not the final Event/Artifact store.

The code belongs under `spikes/` so evidence can drive ADR-0003 without silently promoting prototype details into the Runtime.
