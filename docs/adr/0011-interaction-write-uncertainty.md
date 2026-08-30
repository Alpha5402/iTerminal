# ADR-0011: Durable Input/Control write-attempt boundary

- Status: Accepted for M8.3
- Date: 2026-08-30

## Context

Input and Control target a live foreground Execution and may cause irreversible effects: submitting a REPL line, confirming a prompt, interrupting a process, or sending EOF. M4.1 durably records the immutable Action before calling the PTY adapter and records `DELIVERED` after the adapter returns. A Runtime process can still die between those two points.

Neither PostgreSQL nor a reconnecting client can infer whether the kernel accepted the bytes or signal. Automatically repeating an `ACCEPTED` Input/Control Action could therefore submit or interrupt twice.

## Decision

Every Input/Control delivery uses four ordered boundaries:

1. commit the immutable Action and `action.accepted` Event while its status is `ACCEPTED`;
2. in a second expected-state transaction, commit `interaction.write_attempted` while the exact owner, generation, active Execution, Action kind, and `ACCEPTED` status are still current;
3. call the owner-local PTY adapter exactly once;
4. only after the adapter returns, commit `DELIVERED` and its outcome Event.

The write-attempt Event includes the target Execution and Actor attribution. Input records the byte length, not a second copy of its content; Control records its explicit delivery mode.

If the Runtime dies after step 2, stable-owner recovery marks the live generation `BROKEN`, its Execution `UNKNOWN`, and every still-`ACCEPTED` Input/Control Action `UNKNOWN`. A replacement Runtime does not hydrate the old PTY or replay the Action. Retrying against the old Session fails because that live generation no longer exists.

`interaction.write_attempted` is conservative intent evidence. It proves that all durable preconditions held immediately before the adapter call; it does not prove that the foreground process observed the bytes or signal. The external effect may have happened zero or one time.

## Consequences

- A durability failure before the write-attempt transaction prevents the PTY side effect and breaks the unauditable live generation.
- A process loss after the write attempt is intentionally non-retryable and requires human reconciliation or a new generation.
- Ordinary in-process adapter errors still attempt to persist an explicit `interaction.*_unknown` outcome.
- Clients must treat `UNKNOWN` as a terminal uncertainty state, not as permission to reuse the same intent automatically.
- Secret-channel redaction is specified by ADR-0050; broader Approval policy, hostile timing fuzzing, and rebuild UX remain M10 work.
