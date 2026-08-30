# ADR-0047: Explicit Actor capabilities and immutable durable identity

- Status: Accepted for M10.1
- Date: 2026-08-30

## Context

The M6 interaction policy distinguishes Human and Agent roles, but an `Actor` currently carries only an id, type, principal, and client. Application decisions therefore infer authority from `actor.type`, while PostgreSQL upserts can rewrite the type, principal, and client for an existing Actor id. Runtime RPC also accepts the Actor object supplied in the request body.

That is sufficient only for the documented trusted-local M6 contract. It is not a stable foundation for Approval or secret input: authority is implicit, durable identity can drift, and a raw RPC caller can claim a Human role. M10 needs to separate three facts before those features are added:

1. identity: which Actor performed an operation;
2. capability: which operation that Actor may request;
3. authentication: why the Runtime trusts that Actor assertion.

This decision closes the first two facts. ADR-0048 will bind authenticated Runtime RPC grants to them; until then, this slice is not an authentication boundary.

## Decision

### Closed capability vocabulary

Every Actor carries a non-empty, duplicate-free, lexicographically sorted list from this closed set:

- `session.execute`;
- `session.fork`;
- `terminal.input`;
- `terminal.control`;
- `terminal.resize`;
- `interaction.policy.manage`;
- `interaction.guard.manage`;
- `approval.request`;
- `approval.decide`;
- `secret.input`.

Capabilities are affirmative grants. Unknown values, duplicates, non-canonical ordering, or an empty set are invalid; there is no wildcard. Role and capability are both required. A capability never changes the M6 Input Policy or active Guard result, and policy never creates a missing capability.

### Initial profiles

The repository exports canonical initial profiles rather than deriving authority inside Runtime admission:

| Actor type | Initial capabilities                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| Human      | execute, fork, input, control, resize, policy manage, guard manage, approval request/decide, secret input |
| Agent      | execute, fork, input, control, resize, approval request                                                   |
| Scheduler  | execute only                                                                                              |
| System     | execute, fork, control, resize, policy manage                                                             |

These are construction defaults for trusted adapters and tests, not an implicit fallback. Every serialized Actor must include its exact capabilities. Approval and secret capabilities are reserved vocabulary in M10.1; their operations do not exist until later M10 slices.

### Admission order

Application admission checks the operation capability before allocating an Action sequence, persisting an accepted Action, or touching the PTY. Existing generation, Execution, screen, Input Policy, Guard, idempotency, durability, and write-uncertainty rules remain in force.

Capability denial returns `POLICY_DENIED` and records only bounded Actor/operation metadata where the existing rejection path supports an audit Event. It never records command/input/secret content.

The initial enforced matrix is:

| Operation                   | Required capability         |
| --------------------------- | --------------------------- |
| Execute                     | `session.execute`           |
| fork/rebuild                | `session.fork`              |
| Input                       | `terminal.input`            |
| Control                     | `terminal.control`          |
| Resize                      | `terminal.resize`           |
| set Input Policy            | `interaction.policy.manage` |
| acquire/renew/release Guard | `interaction.guard.manage`  |

Read, root Session create, close, dispatch, and wait APIs do not yet carry Actor context. They remain governed by the trusted-local transport boundary until the authenticated RPC grant slice makes the caller available to every operation. M10.1 must not claim those operations are capability-protected.

### Immutable durable Actor identity

PostgreSQL stores `capabilities text[] NOT NULL`. An Actor id permanently binds its type, principal, client, and canonical capability set. Re-observing the exact same Actor is idempotent. Reusing the id with any different field fails with `ACTOR_IDENTITY_CONFLICT`; repositories never update identity on conflict.

This protects historical attribution and prevents later calls from silently changing the meaning of existing Actions and Events. A deliberate identity or capability change requires a new Actor id. Existing rows are migrated to the canonical profile for their stored type.

The Actor comparison used by Guard ownership includes all identity and capability fields. Possessing the same id while presenting different identity data is not the same Actor.

## Consequences

- Application authorization becomes explicit and testable without conflating it with Input Policy.
- Approval and secret-input work can bind to a stable Actor and exact capability set.
- Durable history no longer changes meaning when an Actor id is reused incorrectly.
- Serialized protocol payloads become slightly larger and callers must upgrade to the capability-bearing Actor schema.
- M10.1 does not authenticate a raw Runtime RPC caller. Until ADR-0048 is implemented, a caller that can reach the trusted-local socket can still self-assert an Actor and capability list. Documentation and verification must state this limitation.
- Same-host Shell code still has the host user's authority. Capability policy is not an OS sandbox.

## Rejected alternatives

- **Infer capabilities forever from Actor type:** preserves the current implicit authority and cannot represent least-privilege Actors of the same type.
- **Update an Actor row on id conflict:** rewrites historical attribution and invalidates Approval/audit meaning.
- **Put capabilities only in HTTP/MCP adapters:** creates transport-specific authorization and leaves direct RPC/Application paths inconsistent.
- **Treat capability policy as authentication:** leaves the self-asserted RPC Actor flaw hidden instead of making the remaining boundary explicit.
- **Add Approval and secret input in the same change:** would build security-sensitive state on an identity model that can still drift.
