# Architecture Decision Records

ADRs capture decisions that change runtime truth, not routine implementation details.

| ADR                                         | Decision                                                 | Status                   |
| ------------------------------------------- | -------------------------------------------------------- | ------------------------ |
| [0001](./0001-session-generation.md)        | Session-centric persistent Shell and generation boundary | Accepted for M0          |
| [0002](./0002-action-execution-state.md)    | Action/Execution states and fail-fast Busy               | Accepted for M0          |
| [0003](./0003-shell-integration-channel.md) | Out-of-band Shell Integration control channel            | Accepted for M0          |
| [0004](./0004-pty-output-observation.md)    | Merged PTY output plus Event/Virtual Screen observations | Accepted for M0          |
| [0005](./0005-interaction-freshness.md)     | Target execution, screen freshness, and Input Guard      | Accepted for MVP         |
| [0006](./0006-checkpoint-fork.md)           | Limited Shell Checkpoint and fork semantics              | Accepted for post-MVP M7 |

Statuses:

- Proposed: evidence or owner decision is still required.
- Accepted: implementation may rely on it.
- Superseded: preserved for history and linked to its replacement.
- Rejected: considered but intentionally not selected.

Changing an Accepted decision requires a new ADR or an explicit amendment with consequences and migration steps.
