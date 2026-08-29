# Canonical terminology

These terms are protocol contracts. Avoid synonyms in code and public APIs unless an adapter must translate them.

| Term               | Meaning                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------- |
| Actor              | Authenticated Human, Agent, Scheduler, or System identity that submits an Action.             |
| Session            | Durable collaboration identity bound to a workspace and a sequence of generations.            |
| Session generation | One live incarnation of a Session. It owns exactly one PTY, Shell, and Executor owner.        |
| PTY                | The operating-system pseudo-terminal carrying one merged input/output terminal stream.        |
| Shell              | The persistent top-level bash/zsh process inside the PTY. It owns the real cwd/env/job state. |
| Action             | Immutable Actor request: Execute, Input, or Control.                                          |
| ExecuteAction      | Request for the persistent Shell to evaluate new top-level Shell input.                       |
| InputAction        | Atomic byte/key batch targeting the current foreground Execution.                             |
| ControlAction      | Explicit TTY control bytes or process-group signal targeting the current Execution.           |
| Execution          | Observed attempt to run one ExecuteAction in a specific Session generation.                   |
| Event              | Append-only durable fact observed or accepted by the Runtime.                                 |
| Snapshot           | Best-effort materialized observation of current Session state; not the live truth itself.     |
| Shell Checkpoint   | Filtered, reconstructable cwd/shell/env state used to fork or rebuild a Session.              |
| Virtual Screen     | Versioned VT/ANSI projection of what the terminal currently displays.                         |
| Interaction Guard  | Short-lived coordination policy that prevents semantically unsafe competing input.            |
| Owner              | Worker/process that physically holds a generation's live PTY. It is not a Human/Agent role.   |
| `UNKNOWN`          | The Runtime cannot prove whether a write or external side effect occurred/completed.          |
| `BROKEN`           | The generation's PTY/Shell/owner/control protocol is lost or no longer trustworthy.           |

## Forbidden conflations

- Action accepted != Execution started != program completed.
- Input delivered != foreground program accepted the input.
- PTY output != separately attributable stdout/stderr.
- Snapshot/checkpoint != live Shell state.
- Session owner Worker != terminal owner Actor.
- Rebuild/fork != PTY or process clone.
- Fencing stale database writes != undoing external side effects.
