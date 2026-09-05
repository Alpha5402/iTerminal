# ADR-0077: Trusted durability failure scope and Session isolation

- Status: Accepted for review remediation D01
- Date: 2026-09-05
- Refines: ADR-0015, ADR-0031, ADR-0034, ADR-0037, ADR-0042

## Context

PostgreSQL failures do not all prove the same blast radius. A transaction can authoritatively reject
one exact Session generation/fencing token while the database and Runtime owner remain healthy. In
that case, closing unrelated PTYs sacrifices availability without adding safety. Conversely, losing
the owner heartbeat/lease confirmation, losing database reachability, or receiving an unclassified
database exception removes the shared authority needed to prove that any local PTY may continue.

The current Runtime treats every `SESSION_LEASE_LOST` as owner-wide and also accepts an untyped
`details.durabilityScope` hint. The first behavior makes a deterministic single-Session fence loss
close every Session; the second is not strong enough to justify narrowing a failure. Error-message
text is not a trust boundary, and the word `lease` does not distinguish a Session fence from an
owner heartbeat failure.

## Decision

### Typed trusted scope

Durability ports may attach this discriminated scope to an internal `RuntimeError`:

```ts
type DurabilityFailureScope =
  | Readonly<{ kind: "owner" }>
  | Readonly<{
      kind: "session";
      sessionId: string;
      generation: number;
      fencingToken: string;
      failureRecord: "committed" | "not_committed";
    }>;
```

A Session scope is trusted only when its identity fields come from the exact `SessionFence` already
passed by Application to the durability port, or from Application's current in-memory Session lease.
Request payloads, PostgreSQL/driver messages, string matching, and partial identifiers are not trusted
scope. Missing, malformed, or partial scope fails closed as owner-wide. The `committed` record marker
may only be created by a repository path that owns the transaction which wrote the failure facts;
Application never accepts an arbitrary externally supplied `RuntimeError.details` object as proof of
that commit.

`failureRecord` distinguishes a transaction that atomically committed the Session's durable
`BROKEN/UNKNOWN` facts before returning an error from a failure that could not commit those facts.
It is evidence metadata, not permission to retry. A fence rejection normally uses `not_committed`:
PostgreSQL authoritatively proved that the attempted token has no write authority, but that rejected
transaction did not append a new failure record. Artifact-admission failure uses `committed` because
the same transaction already persisted the broken Session, unknown work, Event, and lease release.

### Failure matrix

| Failure observation                                                          | Required scope/evidence                                                                           | Application response                                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Exact Session generation/fencing token rejected during one Session mutation  | `SESSION_LEASE_LOST` plus complete trusted Session scope                                          | Invalidate only that exact live Session if the current Session generation and locally held fencing token still match |
| Per-Session failure already durably recorded                                 | Complete trusted Session scope with `failureRecord: committed`                                    | Reflect the committed failure locally for only that exact Session                                                    |
| Explicit `DELIVERY_UNKNOWN` state conflict                                   | Stable domain code produced by the existing Action/Execution uncertainty contract                 | Keep the existing affected-Session handling; this code is not a generic repository exception                         |
| Runtime owner heartbeat or owner lease confirmation lost                     | Owner error, including `OWNER_LEASE_LOST`; Session-lease batch renewal is also owner confirmation | Trip the owner-wide circuit and stop every local Session                                                             |
| PostgreSQL connection failure, database unavailable, or health-probe failure | Owner scope or no narrower trusted scope                                                          | Trip the owner-wide circuit                                                                                          |
| Unknown database/driver exception                                            | No trusted narrower scope                                                                         | Trip the owner-wide circuit; never silently ignore it                                                                |

PostgreSQL statement timeout, driver code, and retryability do not by themselves justify Session
scope. `reportDurabilityUnavailable` is an owner-supervision entry point and therefore always trips
the owner. In particular, heartbeat errors retain their original owner code/scope instead of being
rewrapped as a weaker Session failure.

Apart from a trusted Session scope, only the existing domain `DELIVERY_UNKNOWN` contract remains a
Session-local special case. Any other error which reaches the durability trip path is owner-wide,
including an unclassified `RuntimeError`; adapters must not disguise a database exception as a
domain conflict.

### Application invalidation and stale-error guard

Application remains the only layer that chooses the blast radius. Before applying a Session-scoped
failure it compares all three values `(sessionId, generation, fencingToken)` with the current
in-memory Session and Session lease. A delayed error from an old generation or old token is returned
to its caller but cannot poison the current generation's durable queue, close its executor, or settle
its waiters.

For a matching Session, Application closes write admission for that Session, removes its lease,
marks active work `UNKNOWN`, closes its executor and screen, and wakes/settles its execution waiters.
Other Sessions keep their leases, executors, queues, and ability to Execute/Input/Control. This does
not resume or replay any failed Action.

Owner-wide invalidation preserves ADR-0015: every local PTY closes, active work becomes `UNKNOWN`,
readiness remains unavailable, and recovery reconciles durable truth before admitting new Sessions.
Recovery never replays an `UNKNOWN` Execute/Input/Control and never revives an old generation.

## Consequences

- A deterministic single-Session fence loss no longer destroys unrelated healthy PTYs.
- Owner heartbeat loss and database uncertainty keep their conservative anti-split-brain behavior.
- Ports must preserve exact fence identity in structured error scope; Application does not infer it
  from messages or SQLSTATE.
- A committed durable failure record and inability to persist are observably different, while both
  remain non-replayable.
- Existing unscoped `SESSION_LEASE_LOST` producers remain conservative until they provide complete
  fence-derived scope.

## Verification boundary

D01 uses two live fixture Sessions to inject one exact Session-fence rejection and prove that the
affected Session stops while the other continues Execute and Control. Separate injections retain
owner-wide shutdown for owner lease loss, database outage, and unknown database errors. PostgreSQL
outage recovery proves that `UNKNOWN` work is not replayed. This is local L2 plus the specifically
named failure-injection portion of L4; it is not a claim of complete outage availability, arbitrary
network-partition isolation, cross-host fencing, or production readiness.

## Rejected alternatives

- **Classify by error-message text:** messages are unstable and can conflate owner and Session lease
  failures.
- **Treat every `SESSION_LEASE_LOST` as Session-scoped:** batch renewal and incomplete producers do
  not prove which Session alone is unsafe.
- **Continue writing during database uncertainty:** loses write-ahead truth and permits split brain.
- **Apply a delayed old-token error to the current generation:** allows obsolete work to destroy a
  newly established authority.
- **Replay after recovery:** fence failure or database outage cannot prove whether PTY/external
  effects already occurred.
