# Architecture Decision Records

ADRs capture decisions that change runtime truth, not routine implementation details.

| ADR                                                     | Decision                                                 | Status                   |
| ------------------------------------------------------- | -------------------------------------------------------- | ------------------------ |
| [0001](./0001-session-generation.md)                    | Session-centric persistent Shell and generation boundary | Accepted for M0          |
| [0002](./0002-action-execution-state.md)                | Action/Execution states and fail-fast Busy               | Accepted for M0          |
| [0003](./0003-shell-integration-channel.md)             | Out-of-band Shell Integration control channel            | Accepted for M0          |
| [0004](./0004-pty-output-observation.md)                | Merged PTY output plus Event/Virtual Screen observations | Accepted for M0          |
| [0005](./0005-interaction-freshness.md)                 | Target execution, screen freshness, and Input Guard      | Accepted for MVP         |
| [0006](./0006-checkpoint-fork.md)                       | Limited Shell Checkpoint and fork semantics              | Accepted for post-MVP M7 |
| [0007](./0007-runtime-daemon-mcp-bridge.md)             | Runtime daemon separated from MCP stdio lifecycle        | Accepted for M4          |
| [0008](./0008-live-runtime-durable-journal.md)          | Live PTY truth plus PostgreSQL durable journal           | Accepted for M4.1        |
| [0009](./0009-outbox-rabbitmq-inbox.md)                 | At-least-once Outbox wake-up plus Consumer Inbox         | Accepted for M8.1        |
| [0010](./0010-owner-local-queue-dispatch.md)            | Queue wake-up with owner-local PTY dispatch              | Accepted for M8.2        |
| [0011](./0011-interaction-write-uncertainty.md)         | Durable Input/Control write-attempt boundary             | Accepted for M8.3        |
| [0012](./0012-retry-publish-outage-backoff.md)          | Backoff before NACK when retry publication fails         | Accepted for M8.3        |
| [0013](./0013-admission-outbox-backpressure.md)         | Bound admission during durable delivery backlog          | Accepted for M8.4        |
| [0014](./0014-rabbitmq-reconnect-supervision.md)        | Supervise AMQP reconnect without hiding ambiguity        | Accepted for M8.5        |
| [0015](./0015-postgres-owner-circuit-reconciliation.md) | Trip owner and reconcile before PostgreSQL recovery      | Accepted for M8.6        |

Statuses:

- Proposed: evidence or owner decision is still required.
- Accepted: implementation may rely on it.
- Superseded: preserved for history and linked to its replacement.
- Rejected: considered but intentionally not selected.

Changing an Accepted decision requires a new ADR or an explicit amendment with consequences and migration steps.
