# ADR-0035: Preserve durable truth across Router in-flight crashes

- Status: Accepted for M9.7
- Date: 2026-08-30
- Refines: ADR-0030, ADR-0031, ADR-0032, ADR-0033

## Context

M9.5 proves that a Router can restart without moving live PTYs, but it kills the Router only between requests. Two in-flight boundaries remain distinct: a placement claim may commit before any owner RPC, and an owner mutation may commit before the Router returns its response.

The Router cannot infer durable outcome from a broken client connection. Treating either boundary as an ordinary retry can distort placement accounting or duplicate Shell effects.

## Decision

An atomic placement claim is a monotonic attempt fact, not a reservation. If the Router exits after the claim commits but before forwarding `session.create`, the increment remains. No compensating decrement runs, no Session exists, and a restarted Router selects from the new durable counts. The caller receives `DELIVERY_UNKNOWN` because its mutating Router RPC lost the response; database inspection is the authority.

If an exact owner mutation succeeds and the Router exits before replying, the owner transaction remains authoritative. The Router stores no recovery state and never retries the mutation on another owner. A caller may inspect or repeat an operation only through its original idempotency contract. For `execution.start`, the same Actor, Session, and idempotency key return the original Action and Execution, while Session fencing and the Execution expected version continue to protect later state transitions independently.

Router crash hooks are dependency-injected test seams. Production startup exposes no environment-controlled crash switch.

## Consequences

- Placement fairness counts attempts even when forwarding never begins.
- Router restart requires no local journal or replay queue.
- `DELIVERY_UNKNOWN` describes an epistemic boundary, not proof that a mutation committed.
- Idempotent owner admission can settle a lost Router response without replaying Shell effects.
- Non-idempotent root Session creation still needs a separate client-visible idempotency design for post-forward response loss.

## Verification boundary

M9.7 uses two independent Runtime processes, replaceable independent Router processes, real PostgreSQL, real zsh PTYs, and two precise Router `SIGKILL` hooks. It proves claim-commit-before-forward and successful-`execution.start`-before-response. It is L2 evidence, not a claim about every mutation, kernel-level arbitrary instruction crashes, Router database partitions, or the M9 L4 gate.

## Rejected alternatives

- **Decrement an abandoned placement claim:** crash recovery cannot prove that owner forwarding never began, and the counter is defined as attempts.
- **Retry on another owner:** violates exact Session ownership and can duplicate effects.
- **Persist Router-local recovery state:** creates a second truth beside PostgreSQL and owner state.
- **Return `OWNER_ROUTE_UNAVAILABLE`:** hides that a mutating request may have crossed a process boundary.
- **Call the result exactly once:** idempotent admission and a single observed Shell effect do not prove universal exactly-once execution.
