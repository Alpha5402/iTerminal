# ADR-0072: Bounded and cancellable Execution wait

- Status: Accepted
- Date: 2026-09-05
- Amends: ADR-0002, ADR-0007, ADR-0020, ADR-0030, ADR-0048, ADR-0067, ADR-0068

## Context

The legacy `execution.wait` operation returns the Runtime's shared completion Promise. Its Unix
client uses a 24-hour request timeout, while neither the RPC disconnect signal nor an MCP request
cancellation reaches that Promise. A Router creates another owner request with the same transport
timeout. This makes observation lifetime implicit, cancellation ineffective, and resource release
dependent on the Execution eventually finishing.

An observation timeout is not an Execution deadline. Cancelling one observer must not send input
or control bytes, settle the shared completion, release the active Execution, or affect another
observer. A bounded wait must also distinguish an unavailable owner/backend from a live Execution
that simply remains active.

## Decision

### Additive v2 contract

Application adds a bounded `waitExecutionV2` observation. Runtime RPC exposes it as
`execution.wait.v2` and MCP exposes it as `execution_wait_v2`. The request is a strict bounded
object containing:

- one exact `executionId`;
- `waitMs`, defaulting to 10,000, with an inclusive range from 0 through 30,000 milliseconds.

The response is a strict bounded object containing `executionId`, the current `executionState`,
and `completed`. Here `completed` means that the Execution is in any terminal state:
`COMPLETED`, `FAILED`, `INTERRUPTED`, or `UNKNOWN`. It is false only for `DISPATCHING` or `RUNNING`.
A zero wait is an immediate snapshot. Expiry returns the current snapshot and does not throw an
Execution failure or change its state.

The request intentionally does not add caller-claimed Session or generation fields. The existing
Router resolves the durable exact Execution identity to one live owner in a single route lookup,
and that owner performs the exact live Execution lookup. Unknown Executions remain
`EXECUTION_NOT_FOUND`; an unavailable route or Runtime remains its existing explicit retryable
error and is never converted to `completed: false`.

The legacy `execution.wait` RPC and `execution_wait` MCP tool remain wire-compatible. Their tool
description points new callers to v2, but their unbounded shared-completion behavior is not silently
changed by this additive operation.

### Waiter ownership and cancellation

Application owns one independently removable waiter record per v2 call. A nonzero active wait has
exactly one Application timer and, when supplied, one AbortSignal listener. An injected scheduler
exists only for deterministic wait tests; production uses native timers.

Terminal settlement notifies every current waiter from the existing shared completion boundary.
Each waiter then reads the authoritative current Execution state. Timeout, terminal notification,
abort, synchronous validation failure, and rejection all clear that waiter's timer, remove its
AbortSignal listener, and remove its registry entry. Cancelling one waiter rejects only that
observation with `AbortError`; it does not settle or cancel the shared completion and does not
remove another waiter.

MCP passes its request AbortSignal to the Runtime gateway. A Unix client abort closes its one
request socket; server-side socket close aborts the same request and Application removes the
waiter. A Router forwards the same signal to the exact owner and does not start a second business
wait or reset the requested budget. RPC clients retain only a concurrent transport-failure
backstop long enough for the requested Application wait plus fixed protocol settlement slack; that
backstop is not a second Execution deadline.

No cancellation path sends Ctrl-C, a process signal, input, or any other PTY write. Explicit
Control remains the only way for this API family to request interruption.

### Capability and grants

Updated owner Runtimes advertise `execution.wait.v2`; the Router advertises only that it implements
the forwarding operation, while a scoped capability request still returns the exact owner's
features. Runtime RPC grants authorize `execution.wait.v2` separately from the legacy operation.
Older owners that do not advertise the feature keep serving the legacy operation unchanged.

## Consequences

- New observers have a bounded default and can take an immediate snapshot without polling an
  unbounded completion Promise.
- Multiple Human or Agent observers can use different budgets and cancel independently.
- Disconnects release observation resources promptly without changing terminal truth.
- Callers must interpret `completed` as terminality and inspect `executionState` for the actual
  outcome.
- Legacy callers retain compatibility but should migrate to v2 for bounded resource ownership.

## Rejected alternatives

- **Change legacy wait in place:** old clients expect the full terminal Execution result and may
  rely on its long request lifetime.
- **Use the Router as a second 30-second wait:** resetting the budget at each hop can exceed the
  caller's requested bound and retain duplicate timers.
- **Cancel the shared completion on observer abort:** one client would corrupt every other waiter
  and the Runtime's own settlement path.
- **Send Ctrl-C when a request disconnects:** transport lifetime is not permission to mutate the
  foreground process.
- **Return active on owner/backend failure:** absence of a response is not evidence that an
  Execution remains live.

## Not covered

Durable waiting across owner restart, a user Execution deadline, scheduled cancellation,
observation/output composition, waiter-retention budgets after completion, and per-Session Actor
ACLs remain separate work.
