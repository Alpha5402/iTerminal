# ADR-0032: Atomic fair placement and durable Action rate limits

- Status: Accepted for M9.4
- Date: 2026-08-30
- Refines: ADR-0013, ADR-0023, ADR-0029, ADR-0030, ADR-0031

## Context

M9.2 selects the first owner returned by `listAssignableOwners()`. The list is deterministic, but selection and forwarding are separate operations. Concurrent Router processes can all observe the same active-Session counts before any new Session is durable and route a burst to one owner. This is discovery ordering, not a fairness guarantee.

M9.3 prevents a stale owner from committing, but it does not bound a live Actor or a hot Session. Per-process counters would reset on restart and would not coordinate one Actor across several owners. Rate limiting must be durable, database-time based, and part of the same transaction as Action admission.

## Decision

### Atomic placement claim

`runtime_workers.placement_count` records the number of root-Session placement attempts assigned to each stable logical owner. The Router calls one `claimAssignableOwner()` operation instead of listing and locally choosing.

The claim transaction:

1. acquires a PostgreSQL transaction advisory lock dedicated to placement;
2. selects an unexpired `ACTIVE` owner by `(placement_count, owner_id)`;
3. locks that registry row;
4. increments `placement_count` and registry `version`;
5. returns the exact owner instance/epoch/endpoint used for forwarding.

The short database lock serializes claims across Router processes and forces every claim to re-evaluate the latest count. This slice deliberately favors a simple correctness proof over maximum Session-creation throughput. Existing Session/Execution routing remains lock-free and database-authoritative.

Placement accounting is attempt-based, not active-load or capacity weighting. A forwarded call that later fails still consumes its claim so a bad endpoint is not selected repeatedly in a tight loop. Owner replacement under the same stable owner ID retains the counter; a new logical owner starts at zero and can catch up. Capacity weights, claim cancellation, and overload-aware scheduling require a later ADR.

Migration seeds an existing owner whose counter is still zero from its durable Session-row count. This is only a compatibility approximation for pre-M9.4 history; after migration, every increment is an exact root-Session placement attempt.

### Durable Action rate limits

`actor_action_rate_limit_buckets` and `session_action_rate_limit_buckets` store one fixed-window counter per durable Actor or Session identity. Foreign keys remove counters when those identities are deleted. PostgreSQL `now()` starts and rolls the window; application clocks do not decide admission.

Default durable limits are:

- 120 admitted Actions per Actor per 1,000 ms;
- 240 admitted Actions per Session per 1,000 ms.

Operators may configure all three positive values. Durable Execute, Input, Control, Resize, fork, and Actor-attributed interaction policy/Guard changes consume the Actor bucket and Session bucket in a fixed actor-then-session order. System reconciliation and expiry events without an Actor are not charged.

Idempotency lookup and all semantic/CAS checks run before rate consumption. The bucket increment occurs inside the same PostgreSQL transaction as Action/state admission. A later failure rolls the counter back; a committed admission consumes exactly one unit. Replaying an existing idempotency key returns the original result and consumes no new unit.

If either limit would be exceeded, the transaction rolls back and returns retryable `RATE_LIMITED` with `subjectKind`, `limit`, `windowMilliseconds`, and a database-derived `retryAfterMilliseconds`. `RATE_LIMITED` is distinct from:

- `BACKPRESSURE`, which means durable delivery capacity is exhausted;
- `PTY_BUSY`, which means one Execute is already active;
- `INPUT_GUARDED`/`POLICY_DENIED`, which are interaction-policy decisions.

### Lock order

Production Action admission retains the M9.3 owner-row then Session-lease fence. Within the business transaction it locks the target Session/interaction state, upserts Actor metadata, consumes the Actor bucket then Session bucket, and writes Action/Event rows. Fork and interaction-state paths are adjusted to the same ordering. This avoids Actor-row/rate-bucket versus Session-row lock inversions.

## Consequences

- Concurrent Router processes distribute root Session placement attempts deterministically across live owners.
- Draining, stopped, or expired owners cannot be claimed; existing exact routes retain their prior semantics.
- Actor limits coordinate across Sessions and owners because every durable Runtime shares PostgreSQL.
- Session limits coordinate all Actors targeting one generation's durable Session identity.
- In-memory Runtime mode remains development-only and does not claim cross-process rate-limit guarantees.
- Fixed windows can allow a boundary burst of nearly twice the configured limit. A sliding window or token bucket is intentionally deferred until measurement justifies its complexity.
- Bucket storage is bounded by distinct Actor and Session identities rather than Action volume, but retention/cleanup remains M10 work.

## Verification boundary

M9.4 must exercise concurrent creates through at least three real Runtime owners and prove an assignment skew of at most one while all are ACTIVE, exclusion of a DRAINING owner, cross-owner Actor limiting, per-Session multi-Actor limiting, retry metadata, window reset, rollback, and idempotent replay behavior against real PostgreSQL/PTY/RPC paths.

This is still not the M9 L4 Exit Gate. It does not prove OS-process `SIGKILL` during placement, asymmetric partition, capacity-weighted fairness, Router/database saturation, hostile Actor-ID cardinality, long soak, or live PTY failover.

## Rejected alternatives

- **Keep sorting by active Session count in the Router:** concurrent readers can all choose the same pre-commit count.
- **Use `FOR UPDATE SKIP LOCKED`:** when all owners are briefly locked, a caller can incorrectly observe no assignable owner; skipped rows also weaken deterministic fairness.
- **Use only an in-memory round-robin cursor:** multiple Router processes and restarts diverge.
- **Decrement placement count when Sessions close:** converts a monotonic audit fact into a race-prone load estimate and still does not account for concurrent in-flight creates.
- **Rate limit at MCP/HTTP only:** other adapters and queue paths could bypass it.
- **Increment a counter before the admission transaction:** rejected or rolled-back Actions would consume quota and idempotent replay could be charged twice.
- **Reuse Outbox `BACKPRESSURE`:** delivery capacity and Actor/Session abuse are different operational causes with different retry guidance.
