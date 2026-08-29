# ADR-0001: Session-centric persistent Shell and generation boundary

- Status: Accepted for M0
- Date: 2026-08-30

## Context

The product exists to let Human and Agent actors manipulate the same real shell state. Per-Actor cwd/env snapshots would make execution easier to schedule but would erase the defining shared-environment behavior.

A live PTY is a kernel resource owned by one process. It cannot be serialized, migrated, or recreated from database rows.

## Decision

Each Session generation owns exactly one persistent PTY, one top-level Shell, and one Executor owner. Actors in that Session share the Shell's actual cwd, exported environment, foreground process, REPL, and terminal screen.

When PTY/Shell ownership is lost, that generation becomes `BROKEN`. A rebuild creates a new generation from a limited Shell Checkpoint and preserves lineage. It is never described as resuming the same PTY.

## Consequences

- `cd`, `export`, and `source` naturally affect later actors.
- A Session cannot safely execute two top-level commands concurrently.
- Parallel work requires a separate Session/fork.
- Runtime recovery must distinguish durable facts from lost live state.
- Multi-worker design must route to the physical PTY owner before adding Lease/Fencing.
