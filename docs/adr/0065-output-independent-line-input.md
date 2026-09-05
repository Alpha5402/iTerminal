# ADR-0065: Output-independent foreground line input

- Status: Accepted
- Date: 2026-09-04
- Amends: ADR-0005, ADR-0023, ADR-0011

## Context

Continuous foreground logs advance screenVersion even when nobody types. Screen CAS can
therefore starve an Agent's independent line command throughout tool approval latency.
InteractionState.version alone is insufficient: it tracks policy/Guard, not input bytes.

## Decision

Keep ordinary Input and its optional screen CAS unchanged. Add an explicit `lineInput`
precondition with `expectedInputVersion` and `expectedInteractionVersion`. It is mutually
exclusive with expectedScreenVersion and accepts exactly one nonempty printable line ending
in LF (no embedded CR/LF, escape, tab, or other control characters). The caller asserts that
the exact foreground is a newline-delimited command interface and that the command does not
depend on screen position/content. It is not suitable for a TUI, editor, password/confirmation
prompt, multiline language REPL, or inferring application readiness from an empty cursor row.

`interaction_get` additionally observes `inputContext` for the active Execution:
targetExecutionId, version, and state (`clear`, `pending`, `unknown`). Version is the latest
non-terminal-response Input/SecretInput/Control Action sequence for that Execution, initially
zero. Output and private canonical CPR replies do not change it. The owner keeps one bounded
live context per Session; new Executions reset it and BROKEN state cannot hydrate live context.

Printable raw input marks pending; a terminal CR/LF submission clears pending. Unsupported
editing/control sequences, SecretInput, Control, or uncertain delivery mark unknown for the
rest of that Execution. This conservative observer does not emulate arbitrary line editors.
Guard expiry, output, resize, reconnect, and screen reads never clear pending/unknown input.
Only successfully delivered ordinary printable line submissions can clear pending; unknown
is sticky. No new automatic cancellation, input replay, or Human authorization is introduced.

The existing per-Session mutation lane validates exact generation/Execution, sensitive period,
capability, policy and Guard, then both line precondition versions and clear state before
allocating an Action. Rejection is INPUT_CONTEXT_CHANGED or INPUT_CONTEXT_UNSAFE. PostgreSQL
rechecks interaction version and latest relevant accepted Action sequence while holding the
Session/interaction locks and exact owner fence. The inferred partial-line state is owner-local
PTY context, not a new database-recoverable process truth. The Action JSON payload and request
hash retain the explicit line precondition. Acceptance/write-attempt/delivery and UNKNOWN
semantics are unchanged; identical accepted-key replay precedes later freshness checks.

## Limits and rollout

This prevents mixing with Runtime-observed pending input, not unsent browser/IME drafts or
arbitrary foreground-internal buffers. Existing Human Guard coordination remains required.
A caller cannot treat this as permission to convert a rejected screen-dependent operation to
line input. Refresh/reason about changed input; do not loop until a write succeeds.

Old MCP/RPC servers reject the additive field rather than silently dropping it. Updating source
does not hot-patch a running Runtime: deployment needs an explicitly coordinated restart/new
PTY. Keep online MCC Sessions untouched during isolated tests. No DB migration is required.
