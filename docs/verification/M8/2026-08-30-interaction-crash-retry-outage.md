# M8.3 interaction crash and retry outage verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL 17, RabbitMQ 4.3, Unix RPC, node-pty/zsh, and process-crash integration).** Input and Control Actions now commit an expected-state write-attempt Event before the PTY adapter call. If the owner dies immediately after that call, restart recovery records `BROKEN/UNKNOWN` and does not replay the interaction. A failed retry publication preserves the original RabbitMQ delivery with rate-limited NACK/requeue instead of a hot loop.

This closes the M8.3 local Interaction uncertainty and retry-publisher fault slice. It does not satisfy the full M8 L4 outage, reconnect, pressure, and cross-platform gate.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- PostgreSQL: 17-alpine, disposable `iterminal_test`
- RabbitMQ: 4.3-alpine, disposable single-node broker
- Shell/PTY: real zsh through node-pty
- Failure injection: Runtime child `SIGKILL` after adapter write; live retry exchange deletion

The database suite refuses any database not named exactly `iterminal_test`. Runtime fixtures use disposable short-path workspaces and Unix sockets. RabbitMQ fixtures use per-test quorum queue/exchange prefixes and are removed after each scenario.

## Commands and results

```bash
docker compose -f infra/compose/m8-messaging.yml up -d --wait
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
pnpm test:m8:interactions
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
ITERM_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5673 \
pnpm test:m8:messaging
```

- M8.3 Input/Control owner crash: 2 tests passed.
- M8 messaging including retry-publisher outage: 6 tests passed.

## Proven scenarios

| Scenario               | Result                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Input write boundary   | Action admission and one `interaction.write_attempted` Event commit before `writeInput`                                         |
| Input owner crash      | Runtime receives `SIGKILL` immediately after `writeInput`; restart records Action/Execution/Session as `UNKNOWN/UNKNOWN/BROKEN` |
| Control write boundary | Action admission and one attributed write-attempt Event commit before `sendControl`                                             |
| Control owner crash    | Runtime receives `SIGKILL` immediately after Ctrl+C delivery; restart records uncertainty and never sends the control again     |
| Old-session retry      | Repeating the same request against the restarted owner fails `SESSION_NOT_FOUND`; no old PTY is fabricated                      |
| Retry publisher outage | Deleting the live retry exchange makes confirm publication fail; the original delivery is NACKed and remains in the main queue  |
| No retry hot loop      | Prefetch 1 plus 200 ms backoff limits handler attempts during the observed outage window; nothing reaches the DLQ               |

## Failure semantics observed

- A write-attempt Event is durable before each Input/Control adapter call.
- Process loss after the call is terminal delivery uncertainty, even when no user-visible side effect can be observed.
- The observable fixture side effect occurs at most once and is not replayed after owner recovery.
- Failed retry publication never ACKs the original message.
- Requeue frequency is governed by an explicit backoff and bounded prefetch.

## Not proven

- Every instruction-sized timing gap inside the OS, PTY driver, foreground process, or signal delivery path.
- RabbitMQ channel recreation, broker process restart, network partition, quorum leader loss, jittered exponential backoff, or long outage soak.
- PostgreSQL outage during Interaction write-attempt or while a Worker owns an Inbox lease.
- Full admission/backpressure behavior, repair/operator tooling, metrics, or alerts.
- Multi-worker owner routing, leases, fencing, fairness, or live PTY failover.
- Authentication, authorization, approvals, secret redaction, production TLS/policies, or release operations.
- Human Console or model-driven L3 collaboration path.
