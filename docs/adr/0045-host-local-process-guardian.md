# ADR-0045: Host-local process guardian for unreachable Runtime reclamation

- Status: Accepted for M9.17
- Date: 2026-08-30
- Refines: ADR-0031, ADR-0033, ADR-0042

## Context

PostgreSQL owner and Session leases fence durable writes, and a responsive Runtime closes its local PTYs when lease renewal fails. That does not by itself terminate kernel processes on an old host. A Runtime can be stopped, wedged, or unreachable while its Shell and foreground/background descendants continue running. After the database lease expires, a replacement Runtime is allowed to register, so durable single-writer fencing alone is not proof that the old host stopped producing external effects.

The Router cannot safely send an unauthenticated remote `kill`, and a database row containing only a PID is not sufficient authority: PIDs can be reused, the target may be on another host, and PostgreSQL cannot observe process identity. Whole-host power loss, kernel failure, VM fencing, and network-level isolation remain infrastructure responsibilities.

## Decision

### Independent host-local guardian

- Every durable Runtime starts one independent host-local Guardian child process before it can create a PTY. In-memory development mode does not start one.
- The Guardian is not a Runtime owner, Router, PTY proxy, or database client. It receives only local IPC messages from its parent Runtime.
- A successful owner registration or heartbeat plus Session-lease renewal sends a Guardian renewal. Failed or uncertain database work never renews it.
- The Guardian deadline is derived from the conservative local start of the successful heartbeat round trip. Runtime startup reserves a health-check interval plus the termination grace inside the PostgreSQL owner lease, and each renewal subtracts elapsed database work before arming the Guardian. Forced termination is therefore scheduled before the conservative lease deadline under the stated host-scheduler assumptions.
- A parent IPC disconnect triggers immediate reclamation. A missing renewal triggers reclamation before the database owner lease can normally expire, even if the Runtime process is stopped or its event loop cannot run.

### Exact process-tree registration

- `PtyShellExecutor` registers a Shell only after its integration handshake succeeds and before the Session becomes READY.
- Registration captures the Shell PID, process start identity, and unique PTY TTY from `ps`; it does not assume `node-pty` makes the Shell an operating-system session leader.
- Reclamation first revalidates the Shell PID and start identity. Its snapshot is the union of the current PPID descendant tree and every process still attached to the same PTY TTY, covering foreground and background job-control groups. It first sends `SIGSTOP` to the whole snapshot so terminating a child cannot wake a parent script and trigger its next external effect, then sends `SIGTERM`, waits a bounded grace period, and sends `SIGKILL` only to snapshot members whose PID/start identity still match. PPID is deliberately not part of the second check because surviving children may be reparented after TERM.
- This identity check reduces PID-reuse risk; it does not elevate privileges. The Guardian can terminate only same-user processes permitted by the host kernel.
- Graceful executor close unregisters the Shell. Guardian shutdown reclaims any registered process tree that remains rather than silently abandoning it.

### Recovery semantics

- Guardian reclamation is an external-effect safety action, not a durable transaction. It never marks a Session complete and never retries a Shell command.
- If the frozen Runtime remains the Shell's kernel parent, a terminated child may remain as a non-runnable zombie/exiting record until that parent resumes or exits (`Z` is typical on Linux; macOS may report an `E` exiting flag). Reclamation requires every member to be absent or non-runnable before replacement; final PID disappearance is verified after parent cleanup.
- A replacement Runtime still waits for database-time owner expiry, registers a distinct boot instance, and reconciles the old Session/Execution to `BROKEN/UNKNOWN` before becoming READY.
- The old Runtime cannot revive its old identity after replacement. If it resumes, queued Guardian expiry and the next database heartbeat both trip its owner-wide durability circuit.
- Diagnostics may expose Guardian state, reason, registered-session count, reclaimed-process count, and child PID. They never expose commands, environment, terminal bytes, database URLs, or credentials.

## Consequences

- An unreachable or stopped Runtime process no longer has to resume before its host-local Shell session is reclaimed.
- The Guardian survives a direct Runtime `SIGKILL` or `SIGSTOP` because it is a separate process. Service managers must not place it in a policy that kills or freezes every process in the same host/cgroup when the Runtime alone fails.
- One Guardian serves all PTYs owned by a Runtime; the design does not create one watchdog process per Session.
- If the entire host, kernel scheduler, container, VM, or Guardian process is unavailable, iTerminal cannot prove reclamation from inside that same failure domain. Production must use an external host/VM/container fencing mechanism before treating that machine as harmless.
- This is reclamation of an old process session, not live PTY migration, Session takeover, exactly-once Shell effects, or authorization for arbitrary remote signals.

## Verification boundary

M9.17 must use real independent Runtime/Router/Guardian processes, PostgreSQL, node-pty, and zsh to prove:

1. a live Shell plus foreground and delayed background descendants are registered before Session readiness;
2. stopping only the Runtime process prevents further Guardian renewal while the Guardian remains scheduled;
3. the Guardian makes the Shell and every captured descendant absent or non-runnable before the delayed filesystem effect occurs;
4. after database owner-lease expiry, a distinct same-owner Runtime registers, reconciles the old Session to `BROKEN` and Execution to `UNKNOWN`, and creates only a new PTY;
5. resuming the old Runtime cannot restore its registry identity or old PTY; and
6. graceful shutdown leaves neither Guardian nor registered Shell processes behind.

The result is local L2 evidence for a host-resident reclamation agent while its kernel and scheduler remain available. It is not a real multi-host deployment, external VM/host fencing, privileged cross-user cleanup, container-orchestrator integration, high-cardinality proof, long-duration soak, or the M9 L4 exit gate.
