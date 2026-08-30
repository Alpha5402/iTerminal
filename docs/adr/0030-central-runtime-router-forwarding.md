# ADR-0030: Central Runtime Router forwarding contract

- Status: Accepted for M9.2
- Date: 2026-08-30
- Refines: ADR-0007, ADR-0010, ADR-0029

## Context

M9.1 makes live Runtime owner incarnations discoverable, but every MCP bridge, Human Console, and Execution Worker still needs one owner-specific Unix socket. Clients cannot safely infer the owner of a durable Session or Execution, and letting a queue consumer choose an arbitrary daemon could create an invalid second PTY.

The Router must cover synchronous reads and writes as well as queue-triggered dispatch. RabbitMQ alone cannot route screen reads, interaction state, waits, or lifecycle operations, and it remains only an at-least-once wake-up plane.

## Decision

### Reuse the Runtime RPC surface

The central Router listens on one stable mode-`0600` local Unix socket and implements the existing `RuntimeGateway` contract. MCP, Console, CLI, and an Execution Worker in router mode keep using `UnixRuntimeClient`; they change only the configured socket. The Router owns no Session state machine, PTY, Virtual Screen, Action admission, Inbox, or retry loop.

### Route sources

- `session.create` selects the first PostgreSQL-sorted unexpired `ACTIVE` owner. The current ordering uses durable active-Session count then owner ID; this is deterministic advisory placement, not the final fairness claim.
- Exact Session operations read the durable `sessions.owner_id` and the matching unexpired `ACTIVE` or `DRAINING` registry incarnation in one PostgreSQL statement.
- Execution operations read `executions.owner_id` with the same live-registry join in one statement.
- `session.list` finds every distinct owner of a non-closed durable Session, requires each to have an unexpired `ACTIVE` or `DRAINING` route, and returns one deterministic union from those owners. A missing route or owner failure rejects the whole request; no partial list is labelled complete.
- A draining owner receives no new Session, but existing Session and Execution operations continue to route to it while its lease is live.

The route result carries stable owner ID plus exact instance ID, registry epoch, endpoint, and lease metadata for diagnostics. The Router never turns a missing route into a replacement PTY.

### Failure classification

- A missing Session or Execution remains `SESSION_NOT_FOUND` or `EXECUTION_NOT_FOUND`.
- An existing target whose owner row is missing, stopped, or expired returns retryable `OWNER_ROUTE_UNAVAILABLE` before any owner RPC is attempted.
- A live registry row whose endpoint cannot answer a read is reported as `OWNER_ROUTE_UNAVAILABLE` with bounded owner/instance/epoch diagnostics.
- Once a mutating owner RPC may have been delivered, `DELIVERY_UNKNOWN` remains authoritative. The Router must not downgrade it to route-unavailable or retry automatically.
- A target returned by an owner with a conflicting owner ID is a non-retryable route-integrity failure.
- PostgreSQL failure returns `RUNTIME_UNAVAILABLE`; there is no cached stale route fallback.

### Queue consumer mode

An Execution Worker may run in either:

- `owner` mode: retain the M8 owner equality check and call one owner socket;
- `router` mode: accept any PostgreSQL-inspected owner and call the central Router, which resolves the exact Execution route.

The mode is explicit. Inferring router mode from a socket path or omitted owner ID would make a configuration typo bypass the owner-local M8 safety check.

### Lifecycle

The Router migrates/validates PostgreSQL before opening its socket and closes the public RPC listener before closing its route repository. It does not register as a Runtime owner because it owns no PTY. Router restart does not affect live daemon leases or Sessions.

## Consequences

- One stable socket can serve multiple Runtime owners without moving live PTYs.
- Existing adapters preserve their protocol and Actor semantics.
- Route lookup is fail-closed and database-authoritative; stale in-process route caches cannot outlive a lease.
- Global list availability is intentionally coupled to every live registered endpoint so callers never mistake a partial result for complete state.
- Queue consumers can dispatch across owners without trusting message ordering or constructing PTYs.
- Every forwarded call adds one PostgreSQL lookup and one local Unix hop. Caching and batching require a later correctness proof.

## Explicit boundary

M9.2 does not add generation-scoped Session leases or fencing tokens. Registry route freshness narrows where calls are sent, but it cannot prevent an already-running stale process from committing during a lease/heartbeat race. M9.3 must validate owner, instance, generation, and Session fencing token in the same transaction as every durable mutation. There is still no live PTY failover.

## Rejected alternatives

- **Expose one owner socket to each client:** keeps routing policy duplicated and cannot support owner-agnostic queue consumers.
- **Return partial `session.list` results:** hides an unavailable owner and makes absence ambiguous.
- **Retry a failed write on another endpoint:** can duplicate Shell effects and violates `DELIVERY_UNKNOWN`.
- **Cache routes until process restart:** ignores database-time lease expiry and drain/replacement transitions.
- **Register the Router as a Runtime owner:** conflates a stateless forwarding adapter with PTY authority.
- **Infer routing mode automatically in the Worker:** a misconfigured socket could silently disable the owner equality guard.
