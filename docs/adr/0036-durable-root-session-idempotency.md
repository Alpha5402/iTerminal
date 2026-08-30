# ADR-0036: Bind root Session creation to a durable idempotency intent

- Status: Accepted for M9.8
- Date: 2026-08-30
- Refines: ADR-0030, ADR-0032, ADR-0035

## Context

ADR-0035 preserves durable truth when a Router dies in flight, but root `session.create` previously had no caller-visible identity. If an owner created the Session and PTY before the Router response was lost, the caller could not distinguish success from failure. A fresh create could consume another placement and create a second Session on another owner.

Router-local recovery state cannot close this gap because Routers are replaceable and PostgreSQL is the durable authority. Placement selection and owner creation also cross a process boundary, so a request identity must survive both steps.

## Decision

Every external root Session creation carries a caller-generated `idempotencyKey`. The key is global to root creation and is bound to a canonical hash of `shell` and `workspaceRoot`. Reusing a key with a different request returns `IDEMPOTENCY_KEY_REUSED` before owner forwarding.

The Router serializes a short PostgreSQL transaction with the existing placement advisory lock. For a new key it atomically claims one ACTIVE owner, increments that owner's placement attempt count, and inserts `session_creation_requests` with the exact owner ID, boot instance, and registry epoch. Concurrent Routers replay the same intent instead of consuming another placement. An unfinished intent never moves to another owner; if its exact incarnation is no longer live, retry returns `OWNER_ROUTE_UNAVAILABLE`.

The selected Runtime creates the Session, generation, interaction state, Session lease, and initial Events, then binds the resulting Session ID to the creation intent in the same database transaction. If the Router loses the owner response, a retry reads that bound Session ID and returns the current live owner projection. A completed intent may follow the Session's current live owner incarnation after restart; it never creates another PTY.

MCP, Human Console HTTP, CLI JSONL, and raw Runtime RPC require an explicit key. Internal typed/in-process callers may omit it only for one-shot compatibility, in which case the client or Runtime generates a fresh key and cannot offer caller-controlled settlement after an unknown response.

Session fencing and Execution expected versions remain independent. Creation idempotency chooses and binds one root Session; fencing protects later generation writes; expected versions protect later Execution transitions.

## Consequences

- Post-forward Router response loss can settle to the original Session without a second placement or PTY.
- Two Router processes concurrently handling the same request converge on one exact owner and Session.
- A pre-forward crash leaves an unfinished durable intent rather than silently reassigning work.
- Creation intents require bounded retention and cardinality controls before hostile remote exposure; that remains M10 work.
- This is idempotent admission and durable result lookup, not a universal exactly-once side-effect claim.

## Verification boundary

M9.8 uses two independent Runtime processes, replaceable and concurrent Router processes, real PostgreSQL, real zsh PTYs, and a Router `SIGKILL` after successful owner forwarding. It proves one intent, one placement per key, one Session, replay of the original Session ID, conflict rejection, and subsequent real Shell execution. It is L2 evidence, not the M9 L4 gate or proof of Router/minority partitions, hostile-key retention, remote process reclamation, or long soak.

## Rejected alternatives

- **Generate the key only inside the Router:** the caller cannot repeat it after losing the Router response.
- **Retry placement on any live owner:** can create a second Session and PTY after the first owner committed.
- **Use Session ID as the request key:** the Session ID does not exist at the placement boundary.
- **Store intent in Router memory or local disk:** breaks stateless Router replacement and creates another authority.
- **Treat creation as exactly once:** idempotent database admission does not prove arbitrary external effects occur exactly once.
