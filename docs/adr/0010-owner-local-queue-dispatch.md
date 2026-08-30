# ADR-0010: Queue wake-up with owner-local PTY dispatch

- Status: Accepted for M8.2
- Date: 2026-08-30

## Context

M8.1 proves that a committed `ExecutionReady` Outbox row can reach an Inbox-protected consumer through RabbitMQ. It deliberately leaves the PTY write inside Execute admission. That split proves transport reliability without risking duplicate Shell input, but it does not prove that the queue can drive the live Runtime.

Moving the write behind RabbitMQ creates two different uncertainty boundaries:

1. a Worker may die before or while it asks the owner Runtime to dispatch;
2. the Runtime may die after writing bytes to the PTY but before it reports or persists the outcome.

RabbitMQ redelivery can repair the first boundary. It must not blindly repair the second: a repeated top-level command may duplicate files, deployments, payments, or any other external effect. PostgreSQL can describe the last durable fact, but cannot determine whether bytes already entered a lost PTY.

## Decision

M8.2 separates durable admission, message delivery, and live PTY ownership:

```text
Client
  |
  | Execute admission
  v
Runtime owner ---- transaction ----> PostgreSQL Action/Execution/Event/Outbox
                                         |
                                  leased Outbox relay
                                         |
                                  confirmed RabbitMQ
                                         |
                               Execution Worker + Inbox
                                         |
                               internal Unix dispatch RPC
                                         |
                               same Runtime owner + PTY
```

### Admission and activation

- `startExecute` still performs the authoritative Session reservation and PostgreSQL transaction. In external mode it then returns a `DISPATCHING` Execution without writing the PTY.
- `ITERM_EXECUTION_DISPATCH=external` is allowed only with PostgreSQL durability. In-memory development mode keeps immediate dispatch for M1/M4 compatibility.
- The Outbox relay and Execution Worker are separately supervised processes. The relay publishes the stable Outbox message ID; the Worker uses the existing Consumer Inbox before any dispatch attempt.

### Owner-local routing

- An `ExecutionReady` message is a wake-up, not an ordered task record and not a source of ownership truth.
- Before dispatch, the Worker reloads PostgreSQL and requires a current `DISPATCHING` Execution, matching Session generation, and owner ID.
- The Worker serves one configured Runtime owner/socket pair. It rejects an inspection for another owner rather than forwarding the request.
- The Worker calls the owner daemon over the mode-`0600` Unix RPC operation `execution.dispatch`. Only the live daemon's in-memory projection can resolve that Execution to its PTY.
- Full multi-worker routing, lease transfer, and fencing remain M9. A lost PTY is not moved to another process.

### Dispatch idempotency and acknowledgement

- The owner daemon creates one process-local dispatch state when admission succeeds. Duplicate dispatch RPCs for the same Execution share the same start/completion promises and cannot call the Executor twice.
- The Worker completes its Inbox row and ACKs RabbitMQ only after the daemon reports that the Shell start observation was durably committed.
- If the Worker dies before the RPC, RabbitMQ redelivers. If an RPC result is lost while the daemon remains alive, a retry joins the existing dispatch state.

### PTY write uncertainty

- Before invoking the Executor, the daemon durably appends `execution.write_attempted` while the Session and Execution are still `RESERVED/DISPATCHING` for the expected owner and generation.
- This event is a conservative intent boundary, not proof that the kernel accepted or the Shell executed every byte.
- A daemon crash after that boundary causes normal stable-owner recovery to mark the generation `BROKEN` and the Execution/Action `UNKNOWN`.
- A redelivered message then reloads the terminal database state, records an Inbox stale outcome, and is ACKed without another PTY write.
- The system therefore provides at-least-once wake-up and at-most-one write attempt per live owner process. It does **not** claim exactly-once command execution.

## Consequences

- The production-shaped local path now requires four independently supervised roles: Runtime daemon, Outbox relay, Execution Worker, and MCP/other clients.
- PostgreSQL outage still blocks durable admission; RabbitMQ outage leaves recoverable Outbox work and does not roll back the admitted Action.
- Worker failure before dispatch is retryable. Runtime failure after the write boundary is deliberately non-retryable without human reconciliation.
- Durable `write_attempted`, `started`, and terminal events expose where uncertainty began, but cannot reconstruct a lost PTY.
- Input/Control post-write crash injection, broker reconnect supervision, fencing, security, and long-running chaos remain open gates.
