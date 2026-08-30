# ADR-0028: Durable BROKEN Session rebuild projection

- Status: Accepted for M7.2
- Date: 2026-08-30
- Refines: ADR-0008, ADR-0015, ADR-0027

## Context

PostgreSQL already preserves a Shell checkpoint and owner-loss facts, but a new Runtime process previously held no in-memory route for the historical parent. `session_fork` therefore worked only while that parent still existed in the current process, even though its bounded reconstruction context survived.

Loading database rows as live Sessions would be unsafe. PostgreSQL cannot reconstruct the old PTY, process tree, foreground program, Virtual Screen, Interaction Guard, or delivery certainty. A recovery model must expose durable reconstruction evidence without changing that truth boundary.

## Decision

### Read-only historical projection

After durable owner reconciliation, the Runtime loads at most the newest 100 same-owner Sessions whose current Session and generation are both `BROKEN` and have a checkpoint for that exact generation. Each becomes a read-only in-memory `BROKEN` projection with its stable Session ID, generation, Shell, workspace, sequence counters, optional lineage, and latest checkpoint.

Hydration never creates an Executor, PTY, Virtual Screen, active Execution, Interaction Guard, or READY state. Live screen and interaction operations remain invalid for the historical parent. Durable Event queries continue to read PostgreSQL. Gracefully `CLOSED` Sessions are not hydrated.

The checkpoint must still match its stored content hash and the current Runtime's exact environment allowlist and value bounds. An incompatible or malformed historical record is skipped rather than weakening current policy or preventing unrelated owner recovery. Filesystem existence and realpath containment are checked when a fork is requested, because a missing workspace is useful historical evidence but is not rebuildable live context.

### Explicit rebuild through the existing fork contract

There is no second rebuild execution path. Human Console and Agent clients inspect the historical parent through `session_checkpoint`, acknowledge that its checkpoint is stale, and call the existing Actor-attributed, exact-version, idempotent `session_fork` operation.

Success creates a new Session ID, generation 1, PTY, Shell, Virtual Screen, and Interaction State. It restores only the checkpoint's canonical cwd, Shell kind, and filtered environment overlay, and stores immutable parent/checkpoint lineage. The historical parent remains `BROKEN`; it is never revived or mutated into the child.

The Human Console does not open a live screen WebSocket for `BROKEN` or `CLOSED` Sessions. It displays durable Timeline Events and checkpoint metadata, makes stale acknowledgement explicit, and states that processes, foreground state, REPL/editor memory, vim buffers, jobs, aliases, functions, traps, sockets, and file descriptors are not copied. Workspace files remain shared.

### Ownership boundary

Hydration is restricted to the Runtime's stable `ownerId`. This closes same-owner daemon restart recovery; it does not implement cross-owner routing, PTY migration, or multi-worker takeover. M9 leases/fencing remain responsible for proving exclusive authority across owners.

## Consequences

- A durable checkpoint becomes actionable after a same-owner daemon restart without becoming fake live state.
- One fork admission, lineage, idempotency, and error contract serves READY, busy, and historical BROKEN parents.
- A stale checkpoint always requires explicit caller acknowledgement.
- The bounded newest-100 projection avoids unbounded process memory, while older history remains queryable in PostgreSQL.
- Changing the environment allowlist can intentionally make older checkpoints non-rebuildable.
- Missing or escaped cwd fails at fork time with `CHECKPOINT_INVALID`; the Runtime never silently falls back to workspace root.

## Rejected alternatives

- **Restore a database Session as READY:** invents a PTY and process continuity that do not exist.
- **Create an empty replacement PTY under the old Session ID/generation:** destroys the generation truth boundary and makes stale writes appear current.
- **Automatically fork every checkpoint during startup:** creates side effects without an Actor, stale acknowledgement, or user intent.
- **Load every historical Session:** creates unbounded memory and routing state for audit-only history.
- **Accept checkpoints captured under a broader old environment policy:** silently bypasses the current operator boundary.
- **Hydrate another owner:** conflates durable evidence with distributed ownership and fencing.
