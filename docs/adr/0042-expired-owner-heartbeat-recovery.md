# ADR-0042: Reject expired owner heartbeats before full Runtime recovery

- Status: Accepted for M9.14
- Date: 2026-08-30
- Refines: ADR-0029, ADR-0031, ADR-0033, ADR-0034

## Context

The Runtime owner row is a database-time lease, but ordinary `heartbeatOwner` currently matches only exact owner/instance/epoch/status. If Node is descheduled or its event loop is blocked beyond `lease_expires_at`, the next heartbeat can extend that already expired row. Session lease renewal then rejects its own expired fences and trips the owner-wide durability circuit, so old PTYs are eventually closed; however, the heartbeat and Session renewal are separate transactions. Between them, a Router can briefly observe the expired incarnation as ACTIVE again and commit placement to a Runtime that must immediately fail recovery.

CPU starvation and a database outage are different observations. After a PostgreSQL outage, the process may not know whether its last heartbeat committed. Recovery already closes local PTYs and reconciles durable generations before readiness. After a scheduling pause, PostgreSQL can authoritatively say the lease expired. An ordinary heartbeat must not erase that fact.

The stable owner ID may still recover on the same process when no replacement won. That recovery must be explicit: re-register the boot incarnation, reconcile every old live generation to `BROKEN/UNKNOWN`, and only then return READY. If a boot-unique replacement registered first, the old process must remain fenced out.

## Decision

- `heartbeatOwner`, `beginOwnerDrain`, and `stopOwner` require the exact owner lease to be unexpired at PostgreSQL `now()` in addition to matching owner ID, boot instance, registry epoch, and lifecycle status.
- An expired operation returns non-retryable `OWNER_LEASE_LOST`; it does not update status, heartbeat time, lease expiry, or version.
- The daemon supervisor treats the failed heartbeat as an owner-wide durability failure immediately. Local executors/process groups close best-effort and RPC readiness drops.
- The supervisor may then invoke the existing `registerOwner` recovery path. If the same boot instance still owns the row, re-registration retains the epoch but cannot restore old PTYs; `recoverOwner` first marks old live Sessions `BROKEN`, ambiguous work `UNKNOWN`, and releases old Session leases.
- A new boot instance that registers after expiry advances the registry epoch and prevents the old process from recovering.
- All expiry decisions use PostgreSQL time. Host clocks and event-loop delay are diagnostic only.

## Consequences

- Router placement cannot observe an already expired incarnation as newly ACTIVE merely because its delayed heartbeat ran first.
- Graceful drain attempted after lease expiry becomes a conservative owner-loss shutdown rather than a false `DRAINING/STOPPED` lifecycle.
- Same-process recovery remains possible without claiming PTY continuity; new work requires a new Session lease and PTY.
- The owner registry version no longer advances for rejected expired operations.

## Verification boundary

M9.14 sends actual `SIGSTOP` to one independent Runtime for longer than its owner/Session lease while another Runtime and the Router stay live. PostgreSQL expires only the paused owner, the healthy owner creates and executes real zsh work, `SIGCONT` produces an expired-heartbeat rejection, the old Shell PID disappears, the old Session becomes `BROKEN`, and the same process completes full recovery before creating a distinct new Session/PTY. Registry adapter tests separately prove heartbeat, drain, and stop cannot mutate an expired row.

This is L2 local scheduling-pause evidence, not cgroup CPU quota behavior, host-wide starvation, priority inversion, remote process reclamation, long soak, or M9 L4.

## Rejected alternatives

- **Rely only on Session lease renewal to fail:** leaves a transaction window where routing sees false owner liveness.
- **Let heartbeat renew any exact identity forever:** turns expiry into a routing hint rather than a fencing boundary.
- **Forbid same-process re-registration after expiry:** unnecessarily breaks the conservative database-outage recovery path; full reconciliation is the required safety boundary.
- **Advance registry epoch for same-instance recovery:** registry epoch identifies boot-incarnation replacement, while full recovery already invalidates old Session liveness through generation/fencing state.
- **Use host monotonic time for authority:** Router and Runtime processes need one shared database-time decision.
