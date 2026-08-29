# ADR-0005: Targeted interaction, screen freshness, and short guards

- Status: Accepted for MVP
- Date: 2026-08-30

## Context

Atomic `pty.write()` prevents byte-level interleaving inside one Action but does not prevent semantic races. An Agent may act on an old psql or vim screen after a Human has already changed programs or UI state.

## Decision

- Input/Control must match the current Session generation and active Execution.
- Agent policies may require `expected_screen_version`; mismatches return `SCREEN_CHANGED`.
- A short-lived Interaction Guard protects active Human raw input without creating a permanent terminal owner.
- Default policy is `human_guarded`; supported policies are `common`, `human_guarded`, `human_only`, and `agent_only`.
- Guards have Actor, reason, TTL, and renewal limits. Authorized emergency Control may bypass a guard.

## Consequences

- Human READY input uses a command composer and submits ExecuteAction on Enter.
- Raw key batching is allowed only while an Execution is RUNNING.
- Clients must re-observe rather than retrying stale Input blindly.
