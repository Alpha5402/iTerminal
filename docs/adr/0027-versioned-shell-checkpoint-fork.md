# ADR-0027: Versioned Shell Checkpoint and idempotent Session fork

- Status: Accepted for M7.1
- Date: 2026-08-30
- Refines: ADR-0006

## Context

`PTY_BUSY` deliberately rejects a second Execute in one Session. Parallel work therefore needs a new Session, but a PTY, process tree, REPL heap, editor buffer, file descriptor, job table, alias, function, and trap cannot be cloned portably or honestly.

The initial PostgreSQL schema already contains a `shell_checkpoints` table, but no production path captures filtered exported environment, versions the observation, validates its cwd, restores it into a new Shell, records lineage, or makes a fork retry-safe. A cwd observed after one command is also insufficient: a fork needs an explicit bounded context and must explain exactly what was and was not copied.

## Decision

### Checkpoint contract

Each live Session generation retains at most one latest `ShellCheckpoint`:

```ts
interface ShellCheckpoint {
  sessionId: string;
  sourceGeneration: number;
  version: number;
  workspaceRoot: string;
  cwd: string;
  shell: "bash" | "zsh";
  filteredEnvironment: Readonly<Record<string, string>>;
  contentHash: string;
  observedAt: string;
}
```

The independent Shell Integration control channel emits cwd plus only operator-allowlisted environment keys at each trustworthy `READY` boundary. It does not send the full environment. The Runtime defaults the allowlist to locale variables (`LANG`, `LC_ALL`, and `LC_CTYPE`); an operator may configure additional exact variable names. Names with credential-like terms, Runtime control variables, or dynamic-loader/Shell startup semantics are rejected; the set and values are bounded, and MCP/Console responses expose only included key names, never values.

Checkpoint version starts at 1 when a Session first becomes READY and advances after each completed/interrupted top-level Execute. The content hash is SHA-256 over canonical workspace, cwd, Shell, and sorted filtered environment; timestamps and version are excluded. A READY fork re-certifies the latest Shell observation at the fork instant and advances its version. A RUNNING/RESERVED/BROKEN fork can use only the last completed READY checkpoint.

Before use, Runtime resolves workspace root and checkpoint cwd with `realpath`, requires the cwd to be the workspace itself or a descendant, and fails if it is missing or escapes through a symlink. This containment validates the reconstructed starting cwd; it does not sandbox later Shell commands from accessing paths outside the workspace.

### Fork request and freshness

`session_fork` requires:

- exact parent Session generation;
- Actor-bound idempotency key;
- exact `expectedCheckpointVersion` obtained from `session_checkpoint`;
- `allowStale: true` when the parent is not READY.

A changed version returns `CHECKPOINT_CHANGED`. Missing context returns `CHECKPOINT_NOT_FOUND`; an invalid cwd/environment policy returns `CHECKPOINT_INVALID`; refusing a non-READY source without explicit acknowledgement returns `CHECKPOINT_STALE`. None of these creates a child.

The result identifies the source checkpoint, age, source Session status, whether it was stale, and fixed limitations. It never claims to copy process, REPL, editor, descriptor, job-control, alias/function/trap, or filesystem-isolation state.

### Child and lineage

The child is a new Session ID, generation 1, PTY, Shell, Virtual Screen, Input Policy, and Interaction Guard. It starts at the checkpoint cwd with only the filtered environment overlay. Parent and child continue to share the same workspace filesystem.

PostgreSQL stores immutable parent Session/generation/checkpoint lineage on the child plus an idempotent `session_forks` record keyed by parent Session + Actor + idempotency key. Parent `session.fork_requested` and `session.forked` events and child creation/ready events remain attributable. Durable admission locks and compares the source checkpoint version/hash before accepting a child. Admission failure does not publish the READY re-certification in memory and leaves no child; failure after admission marks the child/fork failed while leaving the parent PTY and Execution untouched. The already admitted checkpoint and audit history remain facts.

The Runtime serializes checkpoint selection and fork admission with parent Session mutations. Retrying an identical request in the same live owner returns the same child. A transport failure is still `DELIVERY_UNKNOWN`; callers inspect/retry the same idempotency key and never create a speculative second child.

### M7.1 and M7.2 boundary

M7.1 proves in-process Runtime/PostgreSQL/RPC/MCP fork behavior with real PTYs, including a busy parent. M7.2 adds Human Console workflow and durable rebuild from a checkpoint after daemon/owner loss. Until M7.2, a checkpoint row surviving restart is durable evidence but the new daemon does not yet hydrate arbitrary historical Sessions into its live routing table.

## Consequences

- Fork becomes explainable reconstruction rather than terminal cloning.
- Environment inheritance is intentionally opt-in and narrower than the parent Shell environment.
- A RUNNING parent can continue independently while the child starts from the last completed boundary.
- Shared workspace files remain a concurrency surface; checkpoint lineage is not Git worktree isolation.
- Operator allowlisting can persist sensitive values if misconfigured. M10 secret-channel/redaction review remains required before release.
- Cross-owner replay/hydration and M9 fencing remain separate because no current component can migrate a live PTY.

## Rejected alternatives

- **Copy `process.env` or `env -0` wholesale:** leaks unrelated host/runtime credentials and does not represent the mutated child Shell safely.
- **Parse `export` commands from Action text:** misses scripts, sourced files, expansions, unsets, and conditional execution.
- **Clone the foreground process or PTY:** not portable and would create false continuity claims.
- **Silently fall back to workspace root:** hides stale or invalid context and makes lineage non-reproducible.
- **Fork without checkpoint CAS or stale acknowledgement:** lets an old UI/Agent unknowingly create a child from a different boundary.
- **Create a Git worktree implicitly:** changes filesystem semantics and exceeds a terminal-runtime fork contract.
