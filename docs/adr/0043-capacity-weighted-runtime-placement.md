# ADR-0043: Weight Runtime placement by declared relative capacity

- Status: Accepted for M9.15
- Date: 2026-08-30
- Refines: ADR-0029, ADR-0032, ADR-0036, ADR-0041

## Context

M9.4 serializes root-Session placement in PostgreSQL and chooses the ACTIVE owner with the lowest historical `placement_count`. This is fair only when every Runtime slot has roughly equal capacity. Real deployments may mix machine sizes or intentionally allocate different shares. Treating a one-core and an eight-core Runtime equally wastes capacity; choosing by current active Session count alone is unstable because terminal workloads vary widely and Session closure would constantly reorder owners.

The capacity signal must not become liveness or fencing authority. Stable owner ID, boot instance, registry epoch, owner lease, Session fencing token, and Execution expected version remain independent facts. A weight is only a relative placement share for new root Sessions.

## Decision

- Every Runtime owner declares an integer `capacity_weight` from 1 through 1000. The default is 1, preserving existing equal-owner behavior.
- `ITERM_RUNTIME_CAPACITY_WEIGHT` configures the production daemon. Registration persists the value for both first boot and boot-unique replacement; heartbeat does not rewrite it.
- PostgreSQL keeps the existing global placement advisory lock and chooses the unexpired ACTIVE owner with the smallest exact ratio `placement_count / capacity_weight`, breaking equal ratios by stable `owner_id`.
- The winning row increments `placement_count` and registry `version` in the same claim transaction. Failed forwarding still consumes the attempt, as before.
- Historical `placement_count` survives drain, stop, and replacement. A returning owner therefore catches up according to its normalized debt rather than resetting to zero and attracting an uncontrolled burst.
- Changing a stable owner's weight on explicit re-registration is allowed. The retained count makes the transition gradual and auditable.
- Capacity weight is not a hard concurrent Session limit, CPU measurement, queue depth, health score, or overload signal.

## Consequences

- Equal default weights retain the M9.4 4/4/4 behavior without caller changes.
- Weights 1:2:3 converge to placement shares 1:2:3 under serialized claims.
- A drained high-weight owner is excluded exactly as before; remaining owners redistribute according to their own weights.
- A replacement can retain or change its declared share without changing Session ownership/fencing semantics.
- Operators must size weights deliberately; bad weights can skew new work but cannot authorize stale writes or move live PTYs.

## Migration and rollback

Migration 013 adds `runtime_workers.capacity_weight integer NOT NULL DEFAULT 1` with a 1–1000 check. Existing rows become weight 1. Old binaries tolerate the additive column and continue equal placement because they ignore it; new binaries require migration before registration. Exact weighted shares are not guaranteed while old and new Router binaries claim concurrently, so operators migrate first and then complete the Router rollout before relying on ratios other than 1.

Rollback must first return every weight to 1 or accept loss of the configured ratios, stop new writers, deploy code that does not select/read the column, drop the check and column, then remove schema version 13. Placement counts and Session history remain valid.

## Verification boundary

M9.15 proves concurrent PostgreSQL registry clients produce exact 1:2:3 shares, invalid weights fail before registration, and independent Runtime/Router processes preserve weighted distribution across drain and same-owner replacement. Real zsh commands run on every weight class. This is L2 relative-capacity evidence, not automatic capacity discovery, hard concurrency admission, heterogeneous CPU benchmark calibration, overload shedding, long soak, or M9 L4.

## Rejected alternatives

- **Reset placement count on restart or weight change:** causes restart-driven traffic bursts and discards stable-owner history.
- **Order only by active Session count:** ignores declared capacity and oscillates as Sessions close.
- **Use floating-point application math:** separate Routers could choose differently; PostgreSQL numeric ordering stays inside the serialized claim.
- **Treat weight as maximum Sessions:** a relative share and a hard resource limit have different failure/retry semantics.
- **Derive weight from host CPU automatically:** topology discovery, cgroups, memory, and workload cost require a separate measured capacity design.
