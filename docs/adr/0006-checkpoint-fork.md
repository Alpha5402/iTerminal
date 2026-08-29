# ADR-0006: Limited Shell Checkpoint and Session fork

- Status: Accepted for post-MVP M7
- Date: 2026-08-30

## Context

Fail-fast Busy means long-running processes need an explicit path to parallel work. A PTY and process state cannot be cloned portably or truthfully.

## Decision

`fork_session` creates a new Session/PTY/Shell from the latest permitted checkpoint. A checkpoint may contain workspace root, cwd, Shell profile, and filtered exported environment.

It never contains foreground/background processes, REPL memory/transactions, vim buffers, sockets, file descriptors, job control, aliases, functions, or traps.

Forking from a RUNNING/BROKEN parent returns checkpoint age and staleness. Missing/invalid cwd or checkpoint is a structured error, not a silent fallback.

## Consequences

- Fork is a rebuild-from-checkpoint operation, not PTY cloning.
- Parent and child share the same workspace filesystem unless a separate git worktree feature is explicitly added later.
- Secret filtering and checkpoint explainability are required before M7 can pass.
