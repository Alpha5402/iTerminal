# ADR-0074: Durable history and idempotency tombstones

- Status: Accepted
- Date: 2026-09-05
- Amends: ADR-0002, ADR-0003, ADR-0039, ADR-0058, ADR-0069, ADR-0071, ADR-0073

## Context

Runtime memory currently owns the only complete Action and Execution lookup view. PostgreSQL keeps
accepted and observed facts, but the Application does not consult them after a safe in-memory
history eviction or a process restart. Normalized fact retention also deletes eligible terminal
Actions and their Executions. Without a durable anti-replay remainder, an idempotency key that has
no versioned age or epoch could later be mistaken for a new request.

PostgreSQL is evidence, not a live-process registry. Reading an old RUNNING row cannot recreate a
Shell, an executor, a completion promise, or a READY Session. Historical reads also need the same
immutable Actor and exact Session/generation scope checks as Action lookup; an Execution id alone
must not become an existence oracle.

## Decision

### Additive exact-scope history contract

Application owns `lookupHistory`. Runtime RPC exposes `history.lookup`, MCP exposes
`history_lookup`, and capable processes advertise `history.lookup.v1`. The authenticated Actor is
injected by the transport grant. The strict request contains an exact `sessionId` and `generation`
plus one target:

- `action` with an `idempotencyKey`; or
- `execution` with an `executionId`.

The result is one of:

- `full`: a bounded public projection of the complete retained fact, with `source` equal to
  `live` or `durable`;
- `compacted`: the minimum retained Action/Execution identity and terminal status needed for
  reconciliation, with `retention.state=expired` and a fixed `expiredAt` timestamp;
- `not_found`: the same result for missing, wrong Actor identity, wrong Session, wrong generation,
  or wrong target kind;
- `unavailable`: a retryable result whose bounded reason is `durability_unavailable`,
  `durability_timeout`, or `owner_route_unavailable`.

The projections omit command text, Action payloads, request hashes, Actor fields, output bodies,
paths, tokens, and other internal model data. `compacted` and retention expiry are separate fields:
the former says which storage fact remains, while the latter says the complete historical record
can no longer be recovered. A tombstone does not imply that the original request may be replayed.

Application validates the complete target scope before returning any fact. PostgreSQL first checks
the immutable Actor identity and then binds Actor, Session, generation, and target in one fact
query. A mismatched scope is non-disclosing. Database errors and statement timeouts are never
translated to `not_found`.

`full.source=live` may contain an active Execution only when the exact owner still has that
Execution in memory. A durable-only active row returns `unavailable`; it is not evidence of a live
process. Durable terminal history may be returned after restart. No history read creates a Session,
registers an executor, restores a completion promise, or changes PTY state.

### Compatibility

Legacy `execution_get` remains the existing owner-memory lookup by Execution id and retains its
wire shape. A06 `action_lookup` also retains its existing result union: complete facts still return
`found`, and a tombstone maps to its already-defined `expired` result. New callers use
`history_lookup` when they need explicit full-versus-compacted provenance for either target.

The Router forwards one exact-session request. Its unscoped capability describes that forwarding
contract, while a scoped capability remains the target owner's exact declaration. A missing or
unreachable owner is `owner_route_unavailable`, not a durable fact reconstructed by the Router.

### Transactional tombstones and retention

Migration 020 adds `action_history_tombstones`. Its primary key preserves the original
Session/Actor/idempotency scope and it also indexes the original Execution id. It stores only the
request hash and minimum reconciliation fields: original ids, kind, terminal statuses, accepted
time, and compaction time. It deliberately does not store command or Action payload.

Normalized retention writes the tombstone and deletes the eligible terminal Action in the same
transaction. The delete cannot commit unless the exact Action id and request hash were inserted or
already match the tombstone. A conflicting tombstone leaves the source Action intact. Tombstone
status constraints accept only terminal Action/Execution states, and their Session-generation
foreign key is restrictive rather than cascading, so deleting a generation cannot silently reopen
its keys. Current-generation facts remain ineligible under ADR-0058. Tombstones are not deleted by
this card: the public key has no verifiable epoch, so there is no safe time at which a persistent
Runtime may treat that key as new. A future bounded-key protocol requires a separate versioned
decision.

The public `compacted.retention.state=expired` boundary begins at the tombstone's `compactedAt`.
This is the point at which the complete Action/Execution fact ceased to be recoverable. It does not
claim that the anti-replay record expired.

### Durable replay before side effects

After an in-memory replay miss, Application checks durable replay identity for Execute, Input,
Control, Secret Input, and Resize before allocating ids or sequence numbers, reserving the Session,
consuming approval or rate-limit capacity, or performing any PTY write/control/resize. A complete
matching terminal fact returns the original Action (and Execution for Execute) without registering
an executor. A complete durable-only active fact is unavailable because its live owner state is
absent. A different request hash returns `IDEMPOTENCY_KEY_REUSED`. Admission lookup deliberately
searches the whole Session/Actor/key scope rather than only the requested generation; a key owned by
another generation is rejected before side effects.

A tombstone always rejects admission. A matching request hash uses the same error code with
`reason=history_expired`; a different hash uses `reason=request_changed`. Both are non-retryable
and create no new Execution. A terminal Session generation independently rejects all new writes.

## Consequences

- Safe memory eviction and owner restart no longer erase retained terminal Action/Execution facts.
- Retention can remove sensitive/full normalized payloads without reopening an idempotency key.
- Tombstones consume durable space indefinitely until a versioned key-epoch design exists; this
  card does not pretend to solve that later capacity policy.
- Existing clients keep their current `execution_get` and `action_lookup` response shapes.
- Active liveness still requires the exact owner memory and executor; PostgreSQL never claims an
  old PTY is READY.

## Rejected alternatives

- **Make legacy `execution_get` durable:** it lacks Actor/Session/generation scope and returns the
  internal model, so doing so would add an existence and payload disclosure path.
- **Delete all idempotency evidence at the retention cutoff:** an unversioned old key could become a
  new mutation and duplicate a side effect.
- **Treat an expired key as a new epoch:** the caller supplied no authenticated epoch.
- **Hydrate durable RUNNING rows as live Executions:** database state cannot prove that an executor
  or PTY still exists.
- **Let the Router query owner storage directly:** that would make an adapter own fact authority and
  conflate historical storage with exact live-owner state.
