# ADR-0060: Dispatch ExecuteAction through the native Shell line editor

- Status: Accepted for M10.14
- Date: 2026-08-31

## Context

The production PTY adapter currently writes an internal wrapper such as
`__it_execute '<command>' '<barrier-token>'` into the interactive Shell. The wrapper preserves Shell
state and emits an ordered completion barrier, but the terminal line editor echoes that private
protocol as if the Human had typed it. The managed profiles also replace the prompt with
`iterminal:zsh%` or `iterminal:bash$`. Consequently the canonical Virtual Screen exposes Runtime
implementation details and does not behave like a native terminal even though execution semantics
are correct.

Filtering or rewriting those bytes after PTY observation would make the durable merged PTY stream
different from what the Shell actually rendered. Disabling terminal echo is also insufficient:
readline and ZLE own prompt-time redisplay independently of the kernel echo flag.

## Decision

The Runtime dispatches an accepted ExecuteAction through a private prompt-time line-editor binding:

1. The adapter writes the exact Action command and one random barrier token to separate `0600` files
   under the generation's private Runtime directory.
2. It sends a reserved escape sequence to the PTY. The managed zsh ZLE binding loads the exact
   command into the editor buffer. macOS bash 3.2 cannot assign `READLINE_LINE`, so its readline
   binding adds the command to in-memory history and immediately recalls that entry into the editor.
   Both paths emit `PREEXEC` on the existing out-of-band control FIFO. Only after the Runtime
   receives that acknowledgement does it send the shell-specific recall/accept keys, so the reserved
   loader sequence cannot leave unconditional input queued behind a foreground program.
3. The Shell therefore renders and evaluates the user's command itself. No wrapper name, quoting, or
   execution identifier enters the visible terminal line.
4. The next prompt hook reads and clears the private token, writes the existing OSC barrier into the
   PTY for output ordering, emits `RESULT`, and then emits `READY` with the checkpoint. The adapter
   still requires `PREEXEC`, `RESULT`/`READY`, and the matching PTY barrier before completion.
5. Managed clean-room profiles use native-shaped prompts (`user@host cwd %/$`) and ordinary `> `
   continuation prompts. This does not load arbitrary user rc files; commands may still customize
   the prompt within the persistent Shell.

The private command file is presentation-neutral transport, not a second execution path. The
Application still owns admission and permits only one active ExecuteAction. Interactive RUNNING
bytes continue to use InputAction and never invoke the prompt-time binding.

## Consequences

- Human and Agent observations contain the actual submitted command rather than `__it_execute`.
- Multiline commands remain one line-editor submission and continue to mutate the persistent Shell.
- Syntax errors still enter `RUNNING` because the binding emits `PREEXEC` before the Shell parser
  accepts the line; prompt return supplies the nonzero result and ordered barrier.
- The Runtime directory and control resources remain discoverable by deliberately hostile code
  running as the same OS user. This preserves ADR-0003's trust boundary and is not an OS sandbox.
- User startup files remain disabled for deterministic integration. Native-shaped means familiar
  interaction and prompt semantics, not byte-for-byte reproduction of Terminal.app login banners or
  the user's personal theme/plugins.

## Rejected alternatives

- **Hide the wrapper in Console CSS or Virtual Screen projection:** changes presentation after PTY
  truth and leaves other transports inconsistent.
- **Erase and redraw the wrapper with ANSI output:** produces a visually plausible screen but leaves
  protocol noise and cursor-rewrite bytes in execution output.
- **Disable TTY echo around dispatch:** readline and ZLE still redisplay their own buffers and it can
  break foreground REPL/password behavior.
- **Execute the command in a child shell:** loses the persistent cwd, environment, functions, jobs,
  and other shared Shell state that defines a Session.
