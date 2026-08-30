# Architecture Decision Records

ADRs capture decisions that change runtime truth, not routine implementation details.

| ADR                                                                      | Decision                                                   | Status                   |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------ |
| [0001](./0001-session-generation.md)                                     | Session-centric persistent Shell and generation boundary   | Accepted for M0          |
| [0002](./0002-action-execution-state.md)                                 | Action/Execution states and fail-fast Busy                 | Accepted for M0          |
| [0003](./0003-shell-integration-channel.md)                              | Out-of-band Shell Integration control channel              | Accepted for M0          |
| [0004](./0004-pty-output-observation.md)                                 | Merged PTY output plus Event/Virtual Screen observations   | Accepted for M0          |
| [0005](./0005-interaction-freshness.md)                                  | Target execution, screen freshness, and Input Guard        | Accepted for MVP         |
| [0006](./0006-checkpoint-fork.md)                                        | Limited Shell Checkpoint and fork semantics                | Accepted for post-MVP M7 |
| [0007](./0007-runtime-daemon-mcp-bridge.md)                              | Runtime daemon separated from MCP stdio lifecycle          | Accepted for M4          |
| [0008](./0008-live-runtime-durable-journal.md)                           | Live PTY truth plus PostgreSQL durable journal             | Accepted for M4.1        |
| [0009](./0009-outbox-rabbitmq-inbox.md)                                  | At-least-once Outbox wake-up plus Consumer Inbox           | Accepted for M8.1        |
| [0010](./0010-owner-local-queue-dispatch.md)                             | Queue wake-up with owner-local PTY dispatch                | Accepted for M8.2        |
| [0011](./0011-interaction-write-uncertainty.md)                          | Durable Input/Control write-attempt boundary               | Accepted for M8.3        |
| [0012](./0012-retry-publish-outage-backoff.md)                           | Backoff before NACK when retry publication fails           | Accepted for M8.3        |
| [0013](./0013-admission-outbox-backpressure.md)                          | Bound admission during durable delivery backlog            | Accepted for M8.4        |
| [0014](./0014-rabbitmq-reconnect-supervision.md)                         | Supervise AMQP reconnect without hiding ambiguity          | Accepted for M8.5        |
| [0015](./0015-postgres-owner-circuit-reconciliation.md)                  | Trip owner and reconcile before PostgreSQL recovery        | Accepted for M8.6        |
| [0016](./0016-messaging-loop-postgres-supervision.md)                    | Pause messaging loops and resume from durable leases       | Accepted for M8.7        |
| [0017](./0017-network-blackhole-liveness.md)                             | Bound liveness detection under silent transport loss       | Accepted for M8.8        |
| [0018](./0018-rabbitmq-quorum-endpoint-failover.md)                      | Pair quorum election with client endpoint failover         | Accepted for M8.9        |
| [0019](./0019-live-virtual-screen-projection.md)                         | Keep one bounded live ANSI/VT screen projection            | Accepted for M6.1        |
| [0020](./0020-reactive-screen-observation.md)                            | Wait and search one bounded live screen reactively         | Accepted for M6.2        |
| [0021](./0021-bounded-screen-region-diff.md)                             | Bound viewport regions, row diffs, and resync              | Accepted for M6.3        |
| [0022](./0022-stable-screen-cell-style-dto.md)                           | Map live styled cells into a stable bounded DTO            | Accepted for M6.4        |
| [0023](./0023-generation-scoped-interaction-policy.md)                   | Version policy and short Human Interaction Guards          | Accepted for M6.5        |
| [0024](./0024-human-console-transport.md)                                | Keep Human HTTP/WS as a loopback Runtime adapter           | Accepted for M5          |
| [0025](./0025-controlled-terminal-geometry.md)                           | Make resize an explicit Runtime-owned versioned Action     | Accepted for M6.6        |
| [0026](./0026-bounded-terminal-state-evidence.md)                        | Expose bounded advisory terminal-state evidence            | Accepted for M6.7        |
| [0027](./0027-versioned-shell-checkpoint-fork.md)                        | Rebuild a child from a versioned filtered checkpoint       | Accepted for M7.1        |
| [0028](./0028-durable-broken-session-rebuild-projection.md)              | Hydrate bounded BROKEN evidence for explicit rebuild       | Accepted for M7.2        |
| [0029](./0029-runtime-owner-registry-and-central-router.md)              | Register Runtime instances and route centrally by owner    | Accepted for M9.1        |
| [0030](./0030-central-runtime-router-forwarding.md)                      | Forward exact Session and Execution calls through Router   | Accepted for M9.2        |
| [0031](./0031-generation-scoped-session-fencing.md)                      | Fence generation writes with an exact Session lease        | Accepted for M9.3        |
| [0032](./0032-atomic-placement-and-durable-action-rate-limits.md)        | Claim fair placement and rate-limit durable Actions        | Accepted for M9.4        |
| [0033](./0033-independent-process-owner-failure-recovery.md)             | Preserve fencing across Router/Runtime process loss        | Accepted for M9.5        |
| [0034](./0034-asymmetric-owner-database-partition.md)                    | Isolate one owner's silent database partition              | Accepted for M9.6        |
| [0035](./0035-router-in-flight-crash-boundaries.md)                      | Preserve durable truth across Router in-flight crashes     | Accepted for M9.7        |
| [0036](./0036-durable-root-session-idempotency.md)                       | Bind root creation to a durable idempotency intent         | Accepted for M9.8        |
| [0037](./0037-router-database-partition-isolation.md)                    | Fail a database-partitioned Router closed                  | Accepted for M9.9        |
| [0038](./0038-router-cold-start-database-supervision.md)                 | Keep Router alive through database cold-start failure      | Accepted for M9.10       |
| [0039](./0039-bounded-session-creation-idempotency.md)                   | Bound root Session idempotency without deleting live truth | Accepted for M9.11       |
| [0040](./0040-bounded-runtime-drain-settlement.md)                       | Settle pre-drain placement before stopping an owner        | Accepted for M9.12       |
| [0041](./0041-repeated-rolling-owner-drain.md)                           | Preserve creation progress across repeated owner drains    | Accepted for M9.13       |
| [0042](./0042-expired-owner-heartbeat-recovery.md)                       | Reject expired heartbeat before full Runtime recovery      | Accepted for M9.14       |
| [0043](./0043-capacity-weighted-runtime-placement.md)                    | Weight Runtime placement by declared relative capacity     | Accepted for M9.15       |
| [0044](./0044-postgres-quorum-primary-failover.md)                       | Follow an externally promoted PostgreSQL primary           | Accepted for M9.16       |
| [0045](./0045-host-local-process-guardian.md)                            | Reclaim unreachable Runtime PTY process trees on-host      | Accepted for M9.17       |
| [0046](./0046-bounded-postgres-pools-and-rolling-soak.md)                | Bound Runtime DB pools and scale rolling soak              | Accepted for M9.18       |
| [0047](./0047-actor-capability-policy-and-immutable-identity.md)         | Make Actor capability explicit and durable identity fixed  | Accepted for M10.1       |
| [0048](./0048-authenticated-runtime-rpc-grants.md)                       | Authenticate scoped caller grants across Router and owner  | Accepted for M10.2       |
| [0049](./0049-durable-agent-execute-approval.md)                         | Bind Human Approval atomically to one Agent Execute        | Accepted for M10.3       |
| [0050](./0050-human-only-secret-input-and-sensitive-output-redaction.md) | Keep Human secret bytes out of ordinary observations       | Accepted for M10.4       |
| [0051](./0051-bounded-artifact-storage-and-maintenance.md)               | Bound Artifact bytes and reclaim expired content           | Accepted for M10.5       |
| [0052](./0052-bounded-pty-output-event-coalescing.md)                    | Coalesce PTY callbacks without crossing truth boundaries   | Accepted for M10.6       |

Statuses:

- Proposed: evidence or owner decision is still required.
- Accepted: implementation may rely on it.
- Superseded: preserved for history and linked to its replacement.
- Rejected: considered but intentionally not selected.

Changing an Accepted decision requires a new ADR or an explicit amendment with consequences and migration steps.
