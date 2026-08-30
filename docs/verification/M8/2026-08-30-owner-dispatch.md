# M8.2 owner-local dispatch verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, RabbitMQ 4.3, Unix RPC, node-pty/zsh, and process-crash integration).** A durably admitted Execute remains `DISPATCHING` until an Inbox-protected Execution Worker wakes the matching owner daemon. Duplicate or recovered wake-ups cause one Shell write, while a lost daemon after the PTY write boundary is recovered as `BROKEN/UNKNOWN` and is not replayed.

This proves the owner-local M8.2 queue-dispatch slice. It does not complete the M8 L4 exit gate or prove multi-worker PTY migration/fencing.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- PostgreSQL: 17-alpine, disposable `iterminal_test`
- RabbitMQ: 4.3-alpine, disposable single-node broker
- Shell/PTY: real zsh through node-pty
- Runtime transport: mode-`0600` Unix socket
- Failure injection: real Worker/Runtime child processes terminated with `SIGKILL`

The suite refuses to mutate a database not named exactly `iterminal_test`. Each scenario has a short disposable workspace/socket, an isolated RabbitMQ quorum topology, and a file append as the externally observable Shell side effect.

## Commands and results

```bash
docker compose -f infra/compose/m8-messaging.yml up -d --wait
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
ITERM_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5673 \
pnpm test:m8:dispatch
```

- M8.2 owner dispatch: 4 tests passed.
- Application external-dispatch and Runtime RPC regression: 6 tests passed.
- M1 immediate-dispatch regression: 5 tests passed.

## Proven scenarios

| Scenario                           | Result                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Queue-gated admission              | Before message publication the Execution remains `DISPATCHING`, the Session remains reserved, and the Shell side effect does not exist                       |
| Normal owner dispatch              | Confirmed `ExecutionReady` reaches the matching Worker/socket; Execution completes and produces one Shell side effect                                        |
| Lost Outbox mark                   | The same wake-up is republished after an expired publisher claim; completed Inbox/daemon dispatch state prevents a second Shell write                        |
| Worker crash before RPC            | Worker acquires Inbox then receives `SIGKILL`; RabbitMQ redelivery plus the expired Inbox lease lets a replacement Worker dispatch once                      |
| Runtime crash after PTY write      | Runtime receives `SIGKILL` immediately after Executor write; replacement owner marks the old generation `BROKEN/UNKNOWN`; retry is stale and not replayed    |
| Runtime crash before finish commit | The real command appends once, Runtime dies after command completion but before terminal persistence, and recovery records `UNKNOWN` without a second append |
| Durable uncertainty boundary       | Exactly one `execution.write_attempted` Event exists for every dispatched crash scenario                                                                     |

## Failure semantics observed

- Worker loss before owner RPC is recoverable through broker redelivery and Inbox lease expiry.
- A duplicate dispatch RPC against a live owner joins one in-memory dispatch state.
- Runtime loss after the durable write-attempt boundary is not retried; Session/Execution recovery is `BROKEN/UNKNOWN`.
- A delayed message is judged from current PostgreSQL state, not its queue position.
- At-least-once notification does not imply exactly-once Shell execution.

## Not proven

- Input/Control post-write process crash and non-replay evidence.
- Runtime crash in every instruction-sized gap between durable `write_attempted`, kernel PTY acceptance, Shell control marker, and output ingest.
- RabbitMQ process loss during retry publication, reconnect supervision, network partition, quorum leader loss, or long outage soak.
- PostgreSQL outage while a Worker owns an Inbox lease, full admission backpressure, or repair/operator workflows.
- Multi-worker routing, ownership lease renewal, fencing tokens, fairness, or live PTY failover.
- Authentication/TLS, authorization, approvals, secret redaction, production topology policies, metrics, or release operations.
- Human Console or model-driven L3 collaboration path.
