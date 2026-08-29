# M4.1 durable Runtime verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real PostgreSQL, PTY/Shell, Unix RPC, stdio MCP, and process-crash integration).** The live MCP daemon now commits Action admission before PTY side effects, ingests attributed PTY Events into PostgreSQL through a bounded per-Session loop, resumes durable cursors across MCP bridge restarts, and recovers a `SIGKILL`-lost owner as `BROKEN/UNKNOWN`.

This closes the earlier gap where M2/M3 database behavior and M4 live MCP behavior were only independently proven. It does not satisfy M4's model-driven L3 Exit Gate.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- PostgreSQL: 17-alpine in the repository Docker Compose fixture
- Shell/PTY: real zsh through node-pty
- MCP: official TypeScript SDK Client over a spawned stdio bridge
- Runtime transport: mode `0600` Unix socket

The test refuses to mutate a database whose name is not exactly `iterminal_test`. Workspaces, sockets, MCP bridges, daemon processes, and PTYs are disposable fixtures.

## Commands and results

```bash
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test pnpm test:m2
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test pnpm test:m3
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test pnpm test:m4:durable
pnpm exec vitest run packages/application/src/runtime-durability.test.ts
pnpm test:m1
pnpm test:m4
```

- M2 reservation/recovery: 6 tests passed.
- M3 bounded observation: 4 tests passed.
- M4.1 durable end to end: 2 tests passed.
- Application durability failure injection: 2 tests passed.
- M1 real bash/zsh regression: 5 tests passed.
- M4 in-memory MCP regression: 1 test passed.

## Proven scenarios

| Scenario                  | Result                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Session lifecycle         | PostgreSQL `STARTING` precedes PTY spawn; Shell handshake commits `READY`                                   |
| Execute write-ahead       | Session reservation, Action, Execution, accepted/dispatching Events, and Outbox commit before Shell execute |
| Input/Control write-ahead | Immutable Actions commit before PTY delivery; post-write status becomes `DELIVERED`                         |
| Shared state              | MCP Agent observes the same durable daemon Shell cwd and exported environment inside Python                 |
| Screen freshness          | An Input carrying the live screen version passes after preceding output is durably ingested                 |
| Attribution               | PTY output Events retain Action, Execution, and Agent Actor identity                                        |
| Bounded observation       | MCP reads PostgreSQL Events through bounded pages rather than the in-memory event array                     |
| Durable reconnect         | First MCP bridge saves numeric `nextAfter`; a new bridge resumes the same durable stream                    |
| Control outcome           | Durable Ctrl+C Action interrupts `sleep`; Action is DELIVERED and Execution is INTERRUPTED                  |
| No pre-admission write    | Injected journal failure leaves Execute/Input unwritten and trips the live generation                       |
| Hard crash                | The actual Node daemon receives `SIGKILL` while `sleep` is RUNNING                                          |
| Restart recovery          | Same socket/owner restart leaves no fake live Session and commits Session BROKEN plus Execution UNKNOWN     |
| Startup readiness         | Bound RPC rejects requests until migration and owner recovery finish, then serves them normally             |
| Process cleanup           | The Shell PID recorded before daemon death disappears after its PTY owner is killed                         |
| Regression                | Existing M1, M2, M3, and base M4 suites remain green                                                        |

## Failure semantics observed

- A journal failure before Execute/Input admission writes no command/input to the Shell.
- Fatal durable failure rejects later mutations and closes/breaks the affected live generation.
- A committed live Execution lost with the daemon is UNKNOWN after recovery and is not replayed.
- Graceful Session close produces CLOSED; restart recovery only targets live states for the stable owner ID.
- The restarted Runtime does not hydrate PostgreSQL rows into a pretend PTY.

## Not proven

- A real model autonomously choosing the MCP tools; explicit external-model authorization is still absent.
- Human Console collaboration, browser reconnect, WebSocket backpressure, or screen resync.
- Real PostgreSQL outage during high-rate PTY output, queue-overflow pressure, retry/repair tooling, or long soak.
- RabbitMQ Outbox publishing, consumer Inbox, ACK/NACK/DLQ, duplicate delivery, or multi-worker routing/fencing.
- Authentication, authorization, approvals, secret redaction, hostile payload fuzzing, or release hardening.
- Linux SIGKILL/process cleanup evidence before the CI run for this commit completes.
