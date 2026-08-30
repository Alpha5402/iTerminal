# ADR-0039: Bound root Session idempotency without deleting live truth

- Status: Accepted for M9.11
- Date: 2026-08-30
- Refines: ADR-0032, ADR-0036

## Context

ADR-0036 gives root `session.create` a durable, globally unique idempotency key. The request row must survive Router crashes and uncertain owner responses, but retaining every caller-controlled key forever lets hostile or faulty clients grow `session_creation_requests` without bound. A process-local limit is insufficient because multiple Routers and direct trusted-local Runtime callers share the table.

Deleting by age alone is also unsafe. An unfinished request may still be executing on its exact live owner, while a completed request may identify an active Session whose replay must continue to return the original Session instead of creating a second PTY.

## Decision

PostgreSQL owns one `session_creation_policies` row with these initial defaults:

- 100,000 retained requests;
- 24-hour minimum retention;
- at most 1,000 cleanup candidates per admission.

Router placement claims acquire the existing placement advisory transaction lock before cleanup, lookup, capacity admission, or insertion. The Runtime durability path first locks and reads the expected Router-created row without taking the global lock; only a missing trusted-local fallback acquires the advisory lock, repeats the lookup, and then performs capacity admission/insertion. The database policy therefore applies consistently across processes without extending the ordinary Router-to-owner creation transaction's global critical section, and a new request cannot race past capacity.

Cleanup is opportunistic and bounded. A request is eligible only when both its retention interval has elapsed and its durable work can no longer be live:

- an unfinished request requires its exact owner incarnation to be stopped, expired, or replaced;
- a completed request requires its Session to be `BROKEN` or `CLOSED`, and retention starts at `completed_at`;
- an unfinished request uses `created_at` as its retention origin.

Cleanup locks candidates with `SKIP LOCKED`, so it does not wait behind a Runtime that is atomically binding a Session. Existing unexpired keys are looked up before capacity enforcement and remain replayable even when the table is full. If a new key still meets or exceeds capacity after cleanup, admission returns retryable `BACKPRESSURE` before owner selection, placement count increment, intent insertion, or PTY creation.

After an eligible request is deleted, its idempotency guarantee has explicitly expired. Reusing that key is a new root-Session request and may create a new Session. Policy changes are made in PostgreSQL rather than per-process environment variables; lowering capacity below current occupancy stops growth but may require eligible rows and repeated admissions before occupancy reaches the new limit.

## Consequences

- Caller-controlled root creation rows have a database-authoritative cardinality bound.
- Active Sessions and in-flight exact-owner work are never removed merely because they are old.
- Multi-Router and direct Runtime admission share one serialization and capacity rule.
- Full-capacity retries with an existing key preserve settlement; unrelated new keys fail before side effects.
- Opportunistic cleanup avoids a mandatory scheduler, but idle expired rows remain until a later admission.
- The policy row is an operator contract and requires backup/migration discipline; a future M10 control plane may expose a validated administration API.

## Verification boundary

M9.11 proves concurrent multi-registry admission cannot exceed a small test capacity, stale unfinished intents become reclaimable only after owner loss and retention, and a production Router preserves active Session replay while rejecting unrelated keys. After close plus retention, the same Router reclaims capacity, creates and executes through a real zsh PTY, and permits an expired key to begin a distinct Session. This is L2 local PostgreSQL/process evidence, not hostile remote authentication, sustained cardinality attack, disk-full behavior, long soak, or the M9 L4 gate.

## Rejected alternatives

- **Per-Router environment limits:** configuration drift makes the global bound non-authoritative.
- **Delete the oldest row whenever full:** can erase an in-flight claim or active Session replay contract.
- **Reject every request at capacity:** prevents safe settlement of already accepted idempotent work.
- **Unbounded periodic retention only:** still permits a burst to exhaust storage before the next sweep.
- **Reuse the event-retention policy:** event history and mutation-idempotency guarantees have different eligibility and expiry semantics.
