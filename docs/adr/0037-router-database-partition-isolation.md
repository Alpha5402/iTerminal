# ADR-0037: Fail a database-partitioned Router closed without cached routing

- Status: Accepted for M9.9
- Date: 2026-08-30
- Refines: ADR-0029, ADR-0030, ADR-0034, ADR-0036

## Context

The central Router is stateless, but every request depends on PostgreSQL-authoritative owner identity, lease, Session/Execution route, or root-creation placement. A Router can lose only its own database path while Runtime owners and another Router remain healthy. Reusing a cached owner endpoint during that interval would bypass lease expiry, owner replacement, drain state, and durable root-creation intent checks.

This failure is different from an unavailable owner endpoint. In the first case the Router cannot establish a current route; in the second it established a current durable route but could not reach that owner.

## Decision

Every Router operation continues to resolve or claim its route through PostgreSQL before any owner RPC. The Router keeps no fallback route cache and performs no owner broadcast. A non-domain database failure becomes retryable `RUNTIME_UNAVAILABLE` with bounded details identifying `component: runtime-router`, the requested operation, and `phase: route_resolution`. It is not mislabeled as `OWNER_ROUTE_UNAVAILABLE` and does not expose raw connection text.

The PostgreSQL client query and connection deadlines bound a silent blackhole. Once one isolated Router fails, another Router with a healthy database path may continue exact routing and placement because both share the same durable authority. The isolated Router process stays alive. Recovery cuts stale TCP streams and lets the existing pool establish fresh connections; no Router restart, local journal, route replay, or placement compensation is required.

If the database path fails only after a route query has already returned, the Router may forward to that exact owner. The owner still performs current owner-incarnation, Session-fence, and Execution-version checks in its own durable transaction. Mutating response loss retains the existing `DELIVERY_UNKNOWN` and idempotency contracts.

## Consequences

- A partitioned Router sacrifices availability instead of risking a stale owner route.
- Healthy Routers and Runtime owners are not globally degraded by one Router's database path.
- Root creation attempted while route resolution is unavailable creates no intent, placement, Session, or PTY; the same key can be retried after recovery.
- Repeated requests during an outage still consume bounded database attempts; fail-fast circuit breaking and admission shedding remain later operational work.
- This slice proves a single PostgreSQL endpoint path blackhole, not PostgreSQL minority/quorum behavior.

## Verification boundary

M9.9 uses two independent Router processes, two independent Runtime processes, one Router-only bidirectional TCP blackhole, real PostgreSQL, and real zsh PTYs. It proves bounded fail-closed behavior, zero owner forward/placement for the isolated request, progress through the healthy Router, in-process isolated-Router recovery after stale-stream reset, and exact-key root creation after recovery. It is L2 evidence, not the M9 L4 gate.

## Rejected alternatives

- **Cache the last owner route:** cannot prove lease, drain, or incarnation freshness during the partition.
- **Broadcast to all owners:** leaks target identity, multiplies side effects, and conflicts with exact ownership.
- **Map database failure to owner unavailability:** collapses two different operational and retry boundaries.
- **Stop all Routers or Runtime owners:** turns an asymmetric control-plane path failure into a global outage.
- **Call this a minority-partition test:** one proxied client path to one PostgreSQL endpoint does not exercise database quorum.
