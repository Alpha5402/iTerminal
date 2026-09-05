# ADR-0001: Session-centric persistent Shell and generation boundary

- Status: Accepted for M0
- Date: 2026-08-30

## Context

The product exists to let Human and Agent actors manipulate the same real shell state. Per-Actor cwd/env snapshots would make execution easier to schedule but would erase the defining shared-environment behavior.

A live PTY is a kernel resource owned by one process. It cannot be serialized, migrated, or recreated from database rows.

## Decision

Each Session generation owns exactly one persistent PTY, one top-level Shell, and one Executor owner. Actors in that Session share the Shell's actual cwd, exported environment, foreground process, REPL, and terminal screen.

When PTY/Shell ownership is lost, that generation becomes `BROKEN`. A rebuild creates a new generation from a limited Shell Checkpoint and preserves lineage. It is never described as resuming the same PTY.

The Executor reports its terminal lifecycle to Application with the exact Session ID, generation,
and an opaque Executor identity. Application serializes that notification in the Session mutation
lane and accepts it only when both the generation and Executor identity still match the live
binding. Duplicate notifications and delayed notifications from an older binding are no-ops.
Transport, PTY, and Guardian adapters never change Session or Execution state directly.

An operator-requested close detaches the binding before closing the Executor and ends as `CLOSED`.
Any other loss of the current binding ends the generation as `BROKEN`. If an Execution was active,
its outcome becomes `UNKNOWN`; an observed Shell process exit is not the command's exit status and
must not populate `Execution.exitCode`. Startup failure remains `STARTING -> BROKEN` and cannot
publish `session.shell_ready`.

`session.broken` and, when applicable, `execution.unknown` use a bounded lifecycle payload. The
stable `reason` is `shell_process_exit` for an observed PTY child exit or `executor_failure` for an
internal Executor/control-path failure. `exitCode` and `signal` are included only when node-pty
observed them for the Shell process. These events do not include the command, environment, terminal
bytes, or other secret-bearing error text.

## Consequences

- `cd`, `export`, and `source` naturally affect later actors.
- A Session cannot safely execute two top-level commands concurrently.
- Parallel work requires a separate Session/fork.
- Runtime recovery must distinguish durable facts from lost live state.
- Executor exit cleanup rejects outstanding waiters, unregisters the Shell from the host-local
  Guardian, disposes live projections, and never triggers an automatic rebuild or command replay.
- Multi-worker design must route to the physical PTY owner before adding Lease/Fencing.
