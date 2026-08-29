# ADR-0008: Live Runtime with a durable PostgreSQL journal

- Status: Accepted for M4.1
- Date: 2026-08-30

## Context

M1 proves the live PTY/Shell state machine with an in-memory projection. M2 and M3 separately prove PostgreSQL reservation, recovery, event search, retention, and artifacts. M4 connects MCP to the live daemon, but the daemon still uses only `MemoryRuntimeStore`. Those independently green slices do not prove that an MCP Action is durably admitted before it reaches the PTY, or that a reconnect cursor observes the live daemon's events.

Replacing the live projection with database rows would also be false: PostgreSQL cannot own or recreate a PTY, foreground process group, REPL memory, or Shell file descriptors. The Application layer needs an explicit boundary between live kernel truth and durable accepted/observed truth.

## Decision

M4.1 keeps one modular-monolith Runtime daemon and introduces an Application-owned durability port:

```text
MCP / future HTTP
       |
  Application Service
       |             \
       |              +--> per-Session durable ingest loop --> PostgreSQL Events/Artifacts
       |
       +--> PostgreSQL admission/transition transaction
       |
       +--> in-memory live projection --> one PTY + Shell
```

### Truth boundaries

- `MemoryRuntimeStore` and the Executor map contain current-process live truth only.
- PostgreSQL contains durable Session, Action, Execution, Event, Snapshot, Outbox, and artifact facts.
- A database row never implies that a PTY survived a Runtime process loss.
- A daemon restart does not hydrate a fake live Session. It marks the previous owner generation `BROKEN` and ambiguous executions/interactions `UNKNOWN`.

### Mutation ordering

Each Session has one short admission sequencer. It serializes admission decisions, not command execution.

1. **Create Session:** persist `STARTING` before spawning the PTY; after the Shell handshake, atomically persist `READY` and its event. Failure closes the PTY and leaves an explicit broken generation.
2. **Execute:** reserve live admission locally, then commit Session `READY -> RESERVED`, Action, Execution, accepted Event, and Outbox in PostgreSQL before writing the command to the PTY. A failed transaction rolls back the local reservation. A committed transaction followed by process loss is recovered as `UNKNOWN`, never replayed automatically.
3. **Input/Control:** commit the immutable Action and accepted Event before the PTY write. Persist `DELIVERED` only after the adapter returns. A lost or failed post-write result becomes `UNKNOWN` and is not auto-replayed.
4. **Execution transitions:** persist `RUNNING` and terminal outcomes with expected-version/state predicates. State and the corresponding Event change in one transaction.
5. **Close:** terminate the live PTY, then durably close the exact generation. Graceful daemon shutdown closes Sessions; ungraceful restart runs owner recovery.

### Event ingest loop

PTY callbacks must not wait on PostgreSQL. The Application layer therefore appends output to the bounded live projection and enqueues a generation-scoped durable write in observation order.

- The queue is bounded to 10,000 pending operations and 8 MiB of pending PTY UTF-8 bytes per Session.
- One Session's writes are serialized; different Sessions may progress independently.
- State transition transactions enter the same ordered chain as output, so durable event sequence reflects observation order.
- A database error or queue overflow trips a durable-health failure. The daemon rejects later mutations, breaks/closes the affected live generation, and exposes the failure; it does not continue an unaudited write path.
- Graceful close drains accepted durable work with a 30-second bound. PostgreSQL connection/query/statement waits are also bounded; timeout or lost connection is reported as an explicit durability failure.

This is a local in-process ingest loop, not the M8 RabbitMQ execution queue. There is still no Execute queue: `PTY_BUSY` remains fail-fast.

### Configuration and ownership

- `ITERM_DATABASE_URL` enables durable mode. Absence keeps the explicit development-only in-memory mode.
- The daemon owner ID is stable for one configured socket identity and may be overridden with `ITERM_RUNTIME_OWNER_ID`.
- The Unix socket is bound before previous-owner recovery, preventing a second daemon for the same socket from breaking a live owner's Sessions. The RPC listener returns retryable `RUNTIME_UNAVAILABLE` until migration and recovery finish, so binding the socket does not expose a half-initialized Runtime.
- M4.1 may auto-run idempotent local migrations at startup; release migration policy remains an M10 operator concern.

## Consequences

- The MCP path can prove real PTY Actions and durable PostgreSQL facts in one scenario.
- API/MCP adapters remain thin and share the same Application arbitration.
- Public Runtime mutation APIs become asynchronous where a durable write must precede a PTY side effect.
- The in-memory projection is deliberately not rehydrated after restart; historical facts remain queryable through durable observation, while live Session calls report no resumable PTY.
- RabbitMQ publisher/consumer recovery, duplicate delivery, DLQ, and multi-worker fencing remain M8/M9 work.
- Authentication, secret redaction, approval policy, and hostile resource testing remain later security gates.
