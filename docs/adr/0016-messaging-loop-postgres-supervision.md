# ADR-0016: Messaging loops pause on PostgreSQL loss and resume from durable leases

- Status: Accepted for M8.7
- Date: 2026-08-30

## Context

The Outbox relay and Execution Worker are standalone loops with two independent dependencies: PostgreSQL carries durable admission, claim, and Inbox truth; RabbitMQ carries at-least-once wake-ups. Today both processes migrate PostgreSQL before starting. A cold database therefore terminates the process, and a running relay also exits when a claim or publish-state update loses its connection. The Worker can receive the same delivery repeatedly while its Inbox repository is unavailable.

An Outbox publish has an unavoidable ambiguity window. RabbitMQ may confirm the message and PostgreSQL may fail before `published_at` commits. Recovery cannot prove that the message was absent from the broker, so changing the row to published without a database commit or suppressing its later lease-based retry would lose work. Republishing after the claim lease expires is safe only because the consumer uses the durable Inbox and the Runtime validates the current Execution state before PTY dispatch.

## Decision

### Shared PostgreSQL supervision

- Relay and Worker use one reusable supervised PostgreSQL messaging repository with `CONNECTING`, `CONNECTED`, and `DISCONNECTED` states.
- Initial migration, bounded health probes, and reconnection use capped exponential backoff with jitter. A process may start degraded while PostgreSQL is unavailable and becomes ready without an operating-system process restart.
- Known connection, administrator-shutdown, and network failures open the database circuit immediately. Unexpected schema, programming, or domain errors remain fatal instead of being hidden by an infinite reconnect loop.
- Connection state diagnostics expose attempt, retry delay, and sanitized error text; they never expose the database URL.

### Relay behavior

- The relay claims or updates Outbox rows only while the repository is connected. A database outage pauses polling instead of terminating the process or spinning.
- A broker publish failure followed by a successful `releaseFailed` remains the existing retry path.
- If RabbitMQ confirms but `markPublished` cannot commit, the relay does not invent a published result. The claim remains until its durable lease expires; after PostgreSQL recovery it may publish again.
- Duplicate broker messages are therefore expected. This is an at-least-once contract, not exactly-once publication.

### Worker behavior

- The Worker starts or retains a RabbitMQ consumer only while PostgreSQL is connected. Database loss closes the current consumer generation, returning unacknowledged deliveries to RabbitMQ and preventing a hot redelivery loop.
- After database recovery and migration, a new consumer generation starts. It acquires the same durable Inbox before inspection or Runtime dispatch.
- If failure occurs after Runtime dispatch but before Inbox completion, redelivery is allowed. Durable Execution inspection and Runtime dispatch state make the message stale/duplicate or conservatively `UNKNOWN`; the Worker never blindly writes the same command to the PTY.

### Shutdown and ownership

- Reconnect and health waits are abortable. Shutdown first stops polling/consumption, waits for in-flight work, then closes RabbitMQ and PostgreSQL resources.
- Database supervision restores loop availability only. It does not recover a Runtime owner, recreate a PTY, or change Session generation semantics from ADR-0015.

## Consequences

- Relay and Worker survive both cold database startup and a single PostgreSQL process restart.
- PostgreSQL downtime creates backpressure in durable Outbox/RabbitMQ state rather than an in-memory unbounded queue.
- A confirmed-but-unmarked publish may increase delivery attempts, which is observable and safe under the existing Inbox/inspection contract.
- PostgreSQL primary failover, TCP blackholes, authentication rotation, connection storms, disk-full behavior, multi-worker fencing, and long soak remain separate L4 work.
