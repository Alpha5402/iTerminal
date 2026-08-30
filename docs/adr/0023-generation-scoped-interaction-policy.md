# ADR-0023: Generation-scoped interaction policy and short Human guards

- Status: Accepted for M6.5
- Date: 2026-08-30

## Context

ADR-0005 requires targeted Input/Control, optional screen freshness, and a short-lived Interaction Guard. M6.5 needs the exact policy, ordering, persistence, authorization, expiry, and retry contract before those decisions can enter the Runtime.

An atomic `pty.write()` prevents bytes from two Actions being interleaved inside one write. It does not prevent an Agent from inserting a complete input batch while a Human is still composing a raw terminal interaction. A permanent Human/Agent owner would avoid that race by abandoning the equal-Actor model, so it is not selected.

## Decision

### State and scope

Each Session generation has one versioned `InteractionState`:

- policy: `common | human_guarded | human_only | agent_only`;
- monotonically increasing state version, initially `1`;
- zero or one short Human Guard;
- Guard id, full Actor identity, reason, acquisition/expiry timestamps, renewal count, and renewal cap.

State never crosses a generation boundary. A new generation starts at `human_guarded`, version `1`, with no Guard.

### Policy matrix

- `common`: Human and Agent Input/Control are allowed; Guards cannot be acquired and do not block.
- `human_guarded`: Human and Agent Input/Control are allowed when no Guard is active. A Human may acquire a Guard; only its exact Actor may interact until release or expiry.
- `human_only`: Human Input/Control are allowed; Agent is denied; Guards are not used.
- `agent_only`: Agent Input/Control are allowed; Human is denied; Guards are not used.
- Scheduler and System do not inherit Human or Agent interaction rights. Until capability policy exists, their Input/Control is denied.

Human and System may change policy in the trusted-local MVP. Agent and Scheduler may not. Changing to a different policy clears any Guard atomically. Setting the current policy is a no-op.

Only Human may acquire a Guard, only while the generation is `RUNNING` under `human_guarded`. The exact holder may renew or release it. A second acquisition while a Guard is active returns `INPUT_GUARDED`; stale guard id or expected state version returns `INTERACTION_GUARD_CHANGED`.

### Bounds and expiry

- default TTL: 500 ms;
- minimum TTL: 50 ms;
- maximum TTL: 5 s;
- maximum renewals for one Guard: 3;
- renewal sets expiry to `now + ttl`; it does not extend from the previous expiry.

Expiry is reconciled lazily on interaction-state reads and serialized mutations. It advances the version and records exactly one `interaction.guard_expired` event through compare-and-swap. No permanent timer or owner is introduced.

### Admission and emergency Control

Input/Control admission order inside the per-Session mutation serialization is:

1. drain prior durable work;
2. return an already accepted same-key/same-hash Action replay;
3. validate generation, active Execution, and screen precondition;
4. reconcile expired Guard;
5. evaluate policy and active Guard;
6. allocate and durably accept the Action;
7. record the write-attempt boundary before touching the PTY.

The PostgreSQL admission transaction rechecks policy and non-expired Guard to prevent a time-of-check/time-of-use gap. A denied request creates no accepted Action sequence and performs no PTY write. Its audit Event contains Actor and policy/Guard metadata, never raw input bytes.

`bypassGuard` is an explicit, audited ControlAction field. In the trusted-local MVP only a Human Control request may set it. It bypasses an active Guard only; it does not bypass policy, generation, target Execution, screen freshness, approval, or delivery-uncertainty rules.

### Interfaces and retry behavior

Runtime RPC exposes:

- `interaction.get`;
- `interaction.policy.set`;
- `interaction.guard.acquire`;
- `interaction.guard.renew`;
- `interaction.guard.release`.

Mutation requests carry an expected state version. An uncertain transport result is not automatically retried; callers inspect `interaction.get` and reconcile against the returned version/Guard.

MCP exposes only read-only `interaction_get` in M6.5. Agent Input/Control continues through the existing tools and receives structured `INPUT_GUARDED` or `POLICY_DENIED` errors. Human Guard mutation is reserved for the Human Console transport.

## Consequences

- Human raw-key batching can exclude competing Agent input without establishing terminal ownership.
- Guard state and changes are durable facts, but they cannot recreate a lost PTY or revive a broken generation.
- An accepted Action replay remains stable after later policy changes.
- Client disconnect does not strand the Session because TTL bounds the Guard.
- Full capability/approval policy remains M10 work; the MVP role checks are intentionally explicit and narrow.

## Rejected alternatives

- **Atomic writes only:** prevents byte interleaving but not semantic input races.
- **Permanent Human/Agent owner or takeover:** conflicts with the equal-Actor Session model and creates abandoned-lock recovery.
- **Guard only in a WebSocket process:** is invisible to MCP/other Runtime paths and is lost without an auditable transition.
- **Automatic replay after Guard expiry:** can duplicate PTY side effects and violates ADR-0011.
- **Emergency Control bypasses all policy:** turns an operational escape hatch into an authorization bypass.
