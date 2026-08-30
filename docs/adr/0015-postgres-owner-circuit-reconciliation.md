# ADR-0015: PostgreSQL outage trips the Runtime owner and requires reconciliation

- Status: Accepted for M8.6
- Date: 2026-08-30

## Context

PostgreSQL is the durable acceptance and observation truth for a durable Runtime owner. If one Session detects that PostgreSQL is unavailable, continuing to operate another PTY under the same owner would allow unaudited output or writes even though the shared durability dependency is already known to be unhealthy.

The existing Runtime only breaks the Session whose durability operation failed. The daemon also treats an initial database connection failure as a process-start failure, and it does not supervise database recovery after a running Pool loses the server. PostgreSQL's client Pool can create a replacement connection after the server returns, but transport reconnection alone is insufficient: database rows may still describe live generations whose PTYs were closed during the outage.

## Decision

### Failure scope

- A non-domain PostgreSQL failure or `RUNTIME_UNAVAILABLE` from Runtime durability trips an owner-wide circuit breaker.
- The Runtime immediately closes every PTY owned by that process, marks every non-closed in-memory Session `BROKEN`, and marks every active in-memory Execution/Action `UNKNOWN`.
- All durable queues for those Sessions become failed. No existing generation is resumed after database recovery.
- A domain conflict such as `DELIVERY_UNKNOWN`, stale generation, or invalid durable transition remains Session-scoped; it does not prove that the shared database service is unavailable.

### Admission and readiness

- While the owner circuit is open, new Session creation and all RPC operations that require Runtime readiness return retryable `RUNTIME_UNAVAILABLE` before creating or writing a PTY.
- The Unix RPC socket may remain bound so clients can distinguish a degraded daemon from a missing daemon. Readiness is the conjunction of daemon database state and Runtime owner durability health.
- A daemon may start while PostgreSQL is unavailable. It exposes degraded state, creates no Session, and supervises recovery instead of exiting.

### Recovery

- While healthy, the daemon performs a low-frequency PostgreSQL probe. Probe failure opens the owner circuit but never retries a business Action.
- The daemon retries `migrate` and owner recovery with capped exponential backoff and jitter.
- A successful recovery transaction first changes every durable `STARTING/READY/RESERVED/RUNNING` Session for that owner to `BROKEN`, changes active Executions/Actions to `UNKNOWN`, and appends recovery Events.
- Only after that transaction commits does the Runtime clear its owner circuit and the daemon become ready for new Sessions.
- Recovery creates replacement Pool connections as needed but never recreates an old PTY. A new Session has a new Session ID and generation lifecycle.

### Shutdown

- Reconnect waits are abortable. If the daemon shuts down while PostgreSQL is unavailable, it closes all local PTYs without pretending that a durable `CLOSED` transition committed.
- A later daemon start with the same owner ID performs the required durable `BROKEN/UNKNOWN` reconciliation.

## Consequences

- One database outage intentionally sacrifices every live PTY under that owner to preserve the audit/write-ahead invariant.
- The blast radius is larger than a per-Session retry, but no Session continues after durable truth is known to be unavailable.
- Recovery can restore service availability for new Sessions without restarting the daemon process.
- Operators can observe `CONNECTING`, `READY`, and `UNAVAILABLE` database states without exposing the connection string.
- Transparent retries are limited to migration/reconciliation. Execute/Input/Control admission is never replayed by the supervisor.
- Single-container stop/start can validate this behavior locally. TCP blackholes, primary failover, split brain, connection storms, transaction ambiguity at every write boundary, and long-duration soak remain separate L4 work.
