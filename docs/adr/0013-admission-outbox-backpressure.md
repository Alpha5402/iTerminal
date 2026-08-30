# ADR-0013: Bound durable admission when delivery is unavailable

- Status: Accepted for M8.4
- Date: 2026-08-30

## Context

Execute admission is intentionally decoupled from RabbitMQ: PostgreSQL commits the Session reservation, Action, Execution, Event, and Outbox row even when the broker or relay is unavailable. This preserves accepted work, but an extended delivery outage can grow pending Outbox rows without bound as clients create and reserve more Sessions.

Database unavailability is a different boundary. If the admission transaction cannot complete, no Action or Outbox fact exists and the Runtime must not write the command to the PTY. A transient backlog limit should reject only the new admission; it must not be mistaken for database corruption and destroy an otherwise healthy READY Session.

## Decision

### Pending Outbox bound

- New non-replay Execute admissions acquire one PostgreSQL transaction advisory lock, count unpublished Outbox rows, and compare the count with a configured maximum.
- The default maximum is 10,000 pending rows. `ITERM_OUTBOX_MAX_PENDING` may lower or raise it to a positive integer for the local deployment.
- When the bound is reached, the transaction raises retryable `BACKPRESSURE` before reserving the Session or inserting any Action/Event/Execution/Outbox row.
- Matching idempotent replay is resolved before the backlog check; reading an already accepted result does not consume capacity.
- Concurrent admissions share the advisory lock, so they cannot all observe the same last free slot and exceed the bound. Outbox publication need not take the lock; a concurrent publish can only make a rejection conservatively stale.

### Database stall boundary

- PostgreSQL connection/query/statement timeouts remain finite and become configurable for deployment and fault testing through `ITERM_DATABASE_STATEMENT_TIMEOUT_MS`.
- Timeout or lost database connectivity remains `RUNTIME_UNAVAILABLE` and trips the affected live generation because the durable journal can no longer guarantee audit ordering.
- `BACKPRESSURE` is not a durability-health failure. Application admission rolls back its local reservation and leaves the live READY Session usable for a later retry after Outbox capacity is released.

### Pre-commit process loss

- A process loss anywhere before PostgreSQL `COMMIT` relies on database transaction rollback. No Action, Execution, accepted Event, or Outbox row may survive.
- The PTY command is dispatched only after the admission call returns, so a pre-commit process loss cannot write the command.
- Restart recovery still marks the lost PTY generation `BROKEN`; it does not manufacture the rejected Action.

## Expected consequences

- Broker/relay outage preserves up to the configured amount of accepted work, then rejects new work explicitly instead of exhausting disk.
- Capacity release after confirmed publication allows the same untouched READY Session to retry admission.
- The global advisory lock serializes only the short backlog check plus admission transaction; it is suitable for the local-first modular deployment, not the final sharded M9 router.
- Per-tenant quotas, priority/fairness, metrics/alerts, automatic broker reconnect, and sustained outage operations remain later hardening.
