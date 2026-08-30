# Canonical terminology

These terms are protocol contracts. Avoid synonyms in code and public APIs unless an adapter must translate them.

| Term               | Meaning                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Actor              | Authenticated Human, Agent, Scheduler, or System identity that submits an Action.               |
| Session            | Durable collaboration identity bound to a workspace and a sequence of generations.              |
| Session generation | One live incarnation of a Session. It owns exactly one PTY, Shell, and Executor owner.          |
| PTY                | The operating-system pseudo-terminal carrying one merged input/output terminal stream.          |
| Shell              | The persistent top-level bash/zsh process inside the PTY. It owns the real cwd/env/job state.   |
| Action             | Immutable Actor request: Execute, Input, Control, or Resize.                                    |
| ExecuteAction      | Request for the persistent Shell to evaluate new top-level Shell input.                         |
| InputAction        | Atomic byte/key batch targeting the current foreground Execution.                               |
| ControlAction      | Explicit TTY control bytes or process-group signal targeting the current Execution.             |
| ResizeAction       | Explicit version-guarded request to change one generation's canonical terminal geometry.        |
| Execution          | Observed attempt to run one ExecuteAction in a specific Session generation.                     |
| Event              | Append-only durable fact observed or accepted by the Runtime.                                   |
| Snapshot           | Best-effort materialized observation of current Session state; not the live truth itself.       |
| Shell Checkpoint   | Filtered, reconstructable cwd/shell/env state used to fork or rebuild a Session.                |
| Session fork       | New independent Session rebuilt from one exact Shell Checkpoint; never a PTY/process clone.     |
| Virtual Screen     | Versioned VT/ANSI projection of what the terminal currently displays.                           |
| Canonical geometry | Runtime-owned PTY/Virtual Screen rows and columns shared by every viewer of one generation.     |
| TerminalState      | Exact-generation advisory classification built from Runtime facts and bounded terminal signals. |
| Interaction Guard  | Short-lived coordination policy that prevents semantically unsafe competing input.              |
| Owner              | Worker/process that physically holds a generation's live PTY. It is not a Human/Agent role.     |
| `UNKNOWN`          | The Runtime cannot prove whether a write or external side effect occurred/completed.            |
| `BROKEN`           | The generation's PTY/Shell/owner/control protocol is lost or no longer trustworthy.             |

## Forbidden conflations

- Action accepted != Execution started != program completed.
- Input delivered != foreground program accepted the input.
- PTY output != separately attributable stdout/stderr.
- Snapshot/checkpoint != live Shell state.
- Session owner Worker != terminal owner Actor.
- Viewer dimensions != canonical terminal geometry.
- TerminalState kind/confidence != authorization, readiness, completion, approval, or secret-channel state.
- Rebuild/fork != PTY or process clone.
- Fencing stale database writes != undoing external side effects.

## TerminalState evidence boundary

`TerminalState` is a read-only observation, not another Runtime state machine. `sessionStatus`, the active Execution, generation, and screen frame are exact live facts; command-family and viewport-marker evidence are bounded signals. Screen content can be spoofed, the submitted top-level command may not be the foreground process, and this version does not observe terminal echo mode.

The classifier may return `shell_ready`, `running`, `editor`, `pager`, `repl`, `password`, `confirm`, or `unknown` together with `high`, `medium`, or `low` confidence, closed-enum evidence, and explicit limitations. Clients must still use authoritative Session/Execution state, exact identifiers and versions, policy/Guard state, and Human decisions before sending input or control.

## Shell Checkpoint and Session fork boundary

A `ShellCheckpoint` is one versioned READY-boundary observation containing canonical workspace root, cwd, Shell kind, and only operator-allowlisted exported environment. Public adapters expose environment key names, hash, version, age, and staleness, but never environment values. Its hash identifies content; it is not proof that the filesystem stayed unchanged.

`session_fork` creates a new Session ID/generation, PTY, Shell, Virtual Screen, Input Policy, and Guard. The child shares workspace files with its parent but does not inherit processes, REPL/editor memory, descriptors, job control, aliases, functions, or traps. A non-READY parent requires explicit stale-checkpoint acknowledgement.
