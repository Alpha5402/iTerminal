# M8.4 admission and Outbox backpressure verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, RabbitMQ 4.3, Unix RPC, node-pty/zsh, concurrent Sessions, and process-crash integration).** A Runtime killed inside Execute admission before PostgreSQL commit leaves no Action/Execution/accepted Event/Outbox fact and never writes the Shell. Pending Outbox capacity now rejects new admission with retryable `BACKPRESSURE` before Session reservation, remains correct under concurrent Sessions, and opens again after confirmed RabbitMQ publication. A real PostgreSQL row-lock stall times out without a PTY write.

This proves the M8.4 local admission/backpressure slice. It does not prove automatic database/broker reconnect, network partition behavior, or the full M8 production L4 gate.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- PostgreSQL: 17-alpine, disposable `iterminal_test`
- RabbitMQ: 4.3-alpine, disposable single-node broker
- Shell/PTY: real zsh through node-pty
- Failure injection: Runtime `SIGKILL` inside the admission transaction; PostgreSQL row lock plus 200 ms statement timeout

The suite refuses any database not named exactly `iterminal_test`. Workspaces, sockets, PTYs, RabbitMQ topologies, and child processes are disposable fixtures.

## Commands and results

```bash
docker compose -f infra/compose/m8-messaging.yml up -d --wait
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
ITERM_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5673 \
pnpm test:m8:admission
```

- M8.4 admission/backpressure: 4 tests passed.

## Proven scenarios

| Scenario                     | Result                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-commit process loss      | Runtime receives `SIGKILL` after all admission statements but before `COMMIT`; PostgreSQL rolls back Action, Execution, accepted Event, Outbox, and Session reservation     |
| No pre-commit Shell write    | The command's file side effect does not exist after the crash                                                                                                               |
| Lost PTY recovery            | Restart marks the previously READY but process-lost generation `BROKEN` without inventing a rejected Action                                                                 |
| Outbox capacity              | With maximum pending Outbox set to one, a second Session receives retryable `BACKPRESSURE` before any durable Action or local reservation                                   |
| Healthy Session preservation | A capacity rejection leaves the second live Session `READY`; it does not trip durable health or close its PTY                                                               |
| Capacity recovery            | Confirmed RabbitMQ publication marks the first row published; retrying the untouched second request is then admitted                                                        |
| Concurrent bound             | Ten Sessions race with capacity three; exactly three admissions commit, seven receive `BACKPRESSURE`, and pending rows never exceed three                                   |
| Concurrent idempotency       | Matching concurrent requests coalesce to one Action/Execution/Outbox even around the admission advisory lock                                                                |
| Database stall               | A real row lock makes admission exceed its statement timeout; the Runtime returns retryable `RUNTIME_UNAVAILABLE`, breaks the unauditable generation, and writes no command |

## Failure semantics observed

- PostgreSQL commit remains the sole durable acceptance boundary.
- `BACKPRESSURE` is a business-capacity rejection, not a durability failure; local Action sequence and reservation roll back.
- Matching idempotent replay is resolved before capacity checks.
- The transaction advisory lock prevents concurrent admission from oversubscribing the pending Outbox limit.
- Database timeout is durability failure and closes/breaks the affected live generation rather than continuing unaudited.

## Not proven

- PostgreSQL server process kill, failover, DNS/network partition, pool reconnection, or long database outage soak.
- RabbitMQ process kill during admission backlog, automatic channel/connection recreation, quorum leader loss, or long broker outage soak.
- Per-tenant/Actor quotas, admission priority/fairness, distributed counters, or sharded Outbox admission.
- Production capacity sizing, disk-full behavior, metrics, alerts, operator repair, or retention of published Outbox history.
- Multi-worker leases/fencing, authentication, authorization, approvals, secret redaction, or release operations.
- Human Console or model-driven L3 collaboration path.
