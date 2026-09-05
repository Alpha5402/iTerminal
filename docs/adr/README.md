# Architecture Decision Records

ADRs capture decisions that change runtime truth, not routine implementation details.

| ADR                                                                      | Decision                                                     | Status                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------ |
| [0001](./0001-session-generation.md)                                     | Session-centric persistent Shell and generation boundary     | Accepted for M0          |
| [0002](./0002-action-execution-state.md)                                 | Action/Execution states and fail-fast Busy                   | Accepted for M0          |
| [0003](./0003-shell-integration-channel.md)                              | Out-of-band Shell Integration control channel                | Accepted for M0          |
| [0004](./0004-pty-output-observation.md)                                 | Merged PTY output plus Event/Virtual Screen observations     | Accepted for M0          |
| [0005](./0005-interaction-freshness.md)                                  | Target execution, screen freshness, and Input Guard          | Accepted for MVP         |
| [0006](./0006-checkpoint-fork.md)                                        | Limited Shell Checkpoint and fork semantics                  | Accepted for post-MVP M7 |
| [0007](./0007-runtime-daemon-mcp-bridge.md)                              | Runtime daemon separated from MCP stdio lifecycle            | Accepted for M4          |
| [0008](./0008-live-runtime-durable-journal.md)                           | Live PTY truth plus PostgreSQL durable journal               | Accepted for M4.1        |
| [0009](./0009-outbox-rabbitmq-inbox.md)                                  | At-least-once Outbox wake-up plus Consumer Inbox             | Accepted for M8.1        |
| [0010](./0010-owner-local-queue-dispatch.md)                             | Queue wake-up with owner-local PTY dispatch                  | Accepted for M8.2        |
| [0011](./0011-interaction-write-uncertainty.md)                          | Durable Input/Control write-attempt boundary                 | Accepted for M8.3        |
| [0012](./0012-retry-publish-outage-backoff.md)                           | Backoff before NACK when retry publication fails             | Accepted for M8.3        |
| [0013](./0013-admission-outbox-backpressure.md)                          | Bound admission during durable delivery backlog              | Accepted for M8.4        |
| [0014](./0014-rabbitmq-reconnect-supervision.md)                         | Supervise AMQP reconnect without hiding ambiguity            | Accepted for M8.5        |
| [0015](./0015-postgres-owner-circuit-reconciliation.md)                  | Trip owner and reconcile before PostgreSQL recovery          | Accepted for M8.6        |
| [0016](./0016-messaging-loop-postgres-supervision.md)                    | Pause messaging loops and resume from durable leases         | Accepted for M8.7        |
| [0017](./0017-network-blackhole-liveness.md)                             | Bound liveness detection under silent transport loss         | Accepted for M8.8        |
| [0018](./0018-rabbitmq-quorum-endpoint-failover.md)                      | Pair quorum election with client endpoint failover           | Accepted for M8.9        |
| [0019](./0019-live-virtual-screen-projection.md)                         | Keep one bounded live ANSI/VT screen projection              | Accepted for M6.1        |
| [0020](./0020-reactive-screen-observation.md)                            | Wait and search one bounded live screen reactively           | Accepted for M6.2        |
| [0021](./0021-bounded-screen-region-diff.md)                             | Bound viewport regions, row diffs, and resync                | Accepted for M6.3        |
| [0022](./0022-stable-screen-cell-style-dto.md)                           | Map live styled cells into a stable bounded DTO              | Accepted for M6.4        |
| [0023](./0023-generation-scoped-interaction-policy.md)                   | Version policy and short Human Interaction Guards            | Accepted for M6.5        |
| [0024](./0024-human-console-transport.md)                                | Keep Human HTTP/WS as a loopback Runtime adapter             | Accepted for M5          |
| [0025](./0025-controlled-terminal-geometry.md)                           | Make resize an explicit Runtime-owned versioned Action       | Accepted for M6.6        |
| [0026](./0026-bounded-terminal-state-evidence.md)                        | Expose bounded advisory terminal-state evidence              | Accepted for M6.7        |
| [0027](./0027-versioned-shell-checkpoint-fork.md)                        | Rebuild a child from a versioned filtered checkpoint         | Accepted for M7.1        |
| [0028](./0028-durable-broken-session-rebuild-projection.md)              | Hydrate bounded BROKEN evidence for explicit rebuild         | Accepted for M7.2        |
| [0029](./0029-runtime-owner-registry-and-central-router.md)              | Register Runtime instances and route centrally by owner      | Accepted for M9.1        |
| [0030](./0030-central-runtime-router-forwarding.md)                      | Forward exact Session and Execution calls through Router     | Accepted for M9.2        |
| [0031](./0031-generation-scoped-session-fencing.md)                      | Fence generation writes with an exact Session lease          | Accepted for M9.3        |
| [0032](./0032-atomic-placement-and-durable-action-rate-limits.md)        | Claim fair placement and rate-limit durable Actions          | Accepted for M9.4        |
| [0033](./0033-independent-process-owner-failure-recovery.md)             | Preserve fencing across Router/Runtime process loss          | Accepted for M9.5        |
| [0034](./0034-asymmetric-owner-database-partition.md)                    | Isolate one owner's silent database partition                | Accepted for M9.6        |
| [0035](./0035-router-in-flight-crash-boundaries.md)                      | Preserve durable truth across Router in-flight crashes       | Accepted for M9.7        |
| [0036](./0036-durable-root-session-idempotency.md)                       | Bind root creation to a durable idempotency intent           | Accepted for M9.8        |
| [0037](./0037-router-database-partition-isolation.md)                    | Fail a database-partitioned Router closed                    | Accepted for M9.9        |
| [0038](./0038-router-cold-start-database-supervision.md)                 | Keep Router alive through database cold-start failure        | Accepted for M9.10       |
| [0039](./0039-bounded-session-creation-idempotency.md)                   | Bound root Session idempotency without deleting live truth   | Accepted for M9.11       |
| [0040](./0040-bounded-runtime-drain-settlement.md)                       | Settle pre-drain placement before stopping an owner          | Accepted for M9.12       |
| [0041](./0041-repeated-rolling-owner-drain.md)                           | Preserve creation progress across repeated owner drains      | Accepted for M9.13       |
| [0042](./0042-expired-owner-heartbeat-recovery.md)                       | Reject expired heartbeat before full Runtime recovery        | Accepted for M9.14       |
| [0043](./0043-capacity-weighted-runtime-placement.md)                    | Weight Runtime placement by declared relative capacity       | Accepted for M9.15       |
| [0044](./0044-postgres-quorum-primary-failover.md)                       | Follow an externally promoted PostgreSQL primary             | Accepted for M9.16       |
| [0045](./0045-host-local-process-guardian.md)                            | Reclaim unreachable Runtime PTY process trees on-host        | Accepted for M9.17       |
| [0046](./0046-bounded-postgres-pools-and-rolling-soak.md)                | Bound Runtime DB pools and scale rolling soak                | Accepted for M9.18       |
| [0047](./0047-actor-capability-policy-and-immutable-identity.md)         | Make Actor capability explicit and durable identity fixed    | Accepted for M10.1       |
| [0048](./0048-authenticated-runtime-rpc-grants.md)                       | Authenticate scoped caller grants across Router and owner    | Accepted for M10.2       |
| [0049](./0049-durable-agent-execute-approval.md)                         | Bind Human Approval atomically to one Agent Execute          | Accepted for M10.3       |
| [0050](./0050-human-only-secret-input-and-sensitive-output-redaction.md) | Keep Human secret bytes out of ordinary observations         | Accepted for M10.4       |
| [0051](./0051-bounded-artifact-storage-and-maintenance.md)               | Bound Artifact bytes and reclaim expired content             | Accepted for M10.5       |
| [0052](./0052-bounded-pty-output-event-coalescing.md)                    | Coalesce PTY callbacks without crossing truth boundaries     | Accepted for M10.6       |
| [0053](./0053-bounded-cursor-safe-event-retention.md)                    | Delete bounded Event prefixes with explicit cursor resync    | Accepted for M10.7       |
| [0054](./0054-loopback-console-ingress-boundary.md)                      | Bind Console requests and streams to one exact authority     | Accepted for M10.8       |
| [0055](./0055-credential-safe-operational-diagnostics.md)                | Keep grants and connection credentials out of diagnostics    | Accepted for M10.9       |
| [0056](./0056-layered-authorization-matrix.md)                           | Separate Capability, interaction policy, and Approval        | Accepted for M10.10      |
| [0057](./0057-hostile-input-and-ingress-resource-bounds.md)              | Bound hostile Shell/path and local ingress resources         | Accepted for M10.11      |
| [0058][adr-0058]                                                         | Bound normalized facts and signal database capacity          | Accepted for M10.12      |
| [0059](./0059-one-command-local-stack-and-mcp-bootstrap.md)              | Compose one authenticated durable local quickstart           | Accepted for M10.13      |
| [0060](./0060-native-shell-line-editor-dispatch.md)                      | Dispatch through native readline/ZLE without wrapper echo    | Accepted for M10.14      |
| [0061](./0061-active-human-window-terminal-fit.md)                       | Fit shared geometry from the active Human window via Actions | Accepted                 |

See also [ADR-0064](./0064-screen-soft-wrap-copy.md): canonical soft-wrap metadata and
terminal-cell-aware copy without inserting new command bytes.

See also [ADR-0063](./0063-explicit-mcp-credential-file.md): opt-in file-backed MCP credentials,
fixed Actor/socket binding, operator-issued refresh without automatic renewal or operation replay.

See also [ADR-0062](./0062-runtime-terminal-cursor-replies.md): accepted Runtime-generated
cursor-position replies with bounded internal System InputActions.

See also [ADR-0065](./0065-output-independent-line-input.md): explicit output-independent
foreground line input with input-context CAS, partial-input protection, and unchanged Human policy.

See also [ADR-0066](./0066-human-local-line-drafts.md): Human foreground drafts stay local
until Enter, allowing Agent submissions during editing; raw/TUI keys are an explicit mode.

See also [ADR-0067](./0067-execution-lifetime-and-fatal-settlement.md): executions have no
adapter-owned wall-clock lifetime, and fatal settlement preserves the write-acceptance boundary.

See also [ADR-0068](./0068-runtime-capability-negotiation.md): running Runtime and Router
processes report bounded protocol, build, and exact-owner feature capabilities.

See also [ADR-0069](./0069-action-lookup-by-request-identity.md): reconcile accepted Actions by
exact authenticated request identity without replaying a mutation or disclosing payloads.

See also [ADR-0070](./0070-bounded-scoped-artifact-read.md): read already-sanitized Artifact bytes
through an exact database-owned Session scope, bounded byte ranges, non-disclosing misses, and an
explicit UTF-8 text-boundary contract.

See also [ADR-0071](./0071-durable-execution-output-cursor.md): page exact-Execution durable PTY
output with stable Event/byte cursors, explicit Event/Artifact retention gaps, bounded responses,
and honest live persistence lag.

Statuses:

- Proposed: evidence or owner decision is still required.
- Accepted: implementation may rely on it.
- Superseded: preserved for history and linked to its replacement.
- Rejected: considered but intentionally not selected.

Changing an Accepted decision requires a new ADR or an explicit amendment with consequences and migration steps.

[adr-0058]: ./0058-bounded-normalized-fact-retention-and-database-capacity-signal.md
