# ADR-0050: Human-only secret input and fail-closed sensitive output redaction

- Status: Accepted for M10.4
- Date: 2026-08-31

## Context

A password-shaped HTML field is not a secret channel. The existing `InputAction` keeps its `data`
in the in-memory Action and PostgreSQL payload. PTY output is also copied into the Executor session
ring, the active Execution result, `terminal.pty_output` Events, large-output Artifacts, searchable
text, and the Virtual Screen. If a foreground program echoes a password, masking only the browser
would leave several durable copies.

The Runtime cannot infer secret prompts from terminal text or `TerminalState`: any program can print
`Password:`, echo settings are not currently observed, and a heuristic cannot grant Human authority.
It also cannot taint-track an arbitrary process after a secret has been submitted. M10 therefore
needs an explicit Human decision and a bounded claim: no submitted secret or raw PTY output observed
while the sensitive period is active enters ordinary Runtime observation surfaces.

## Decision

### Explicit Human-only lifecycle

The Console exposes an explicit two-step lifecycle:

1. `secret.input.begin` creates one `SecretInputAction`, starts one sensitive period for the exact
   Session generation and active Execution, enables Executor redaction, and writes the transient
   secret once;
2. `secret.input.finish` records the Human-selected outcome `completed | cancelled` and ends
   Executor redaction only after that durable transition commits.

The operation is valid only for an authenticated `human` Actor with `secret.input`. It still obeys
the current Input Policy, active Interaction Guard, exact generation and target Execution, and an
optional expected screen version. `agent_only` denies it. No emergency bypass exists.

At most one sensitive period may be `ACTIVE` in one Session generation. While its Execution is
live, the exact Actor must finish it using the current state version. A disconnect, timeout, Guard
expiry, Execution exit, or transport uncertainty does not automatically disable redaction. This is
intentionally fail-closed. A new Execute is rejected while a period remains active. Once the
Session is `READY` and therefore has no live foreground Execution that can echo the secret, another
capable Human may reconcile an orphaned period. Closing or losing the generation terminates live
observation and may leave only an `UNKNOWN` historical state.

While the period is active, new ordinary Input is denied for every Actor and Control is denied
except for the exact Human who opened the period. That Human may still send an explicit Control such
as Ctrl+C to abort the foreground program, but Control never ends redaction. Resize and read-only
observation remain available against the sanitized stream.

MCP exposes no begin, finish, or secret-state tool. The Human Console server supplies its own
server-held Human Actor; browser input cannot supply an Actor identity.

The Console presents an active period as a compact `***` terminal-status indicator, not a modal or
bottom control panel. The owning Human may click that indicator to commit `secret.input.finish` once
the foreground program can no longer echo the secret. Ctrl+C remains an ordinary terminal key. A
different Actor sees a non-interactive indicator while the Execution is live; once the Session is
`READY`, that indicator becomes the explicit orphan-recovery action.

### Metadata-only Action and state

`SecretInputAction` is an immutable Action but never contains secret bytes, a secret hash, byte
length, character length, masked value, or derived preview. Its durable payload contains only:

- sensitive input id;
- target Execution id;
- optional expected screen version.

The sensitive state contains id, Session/generation, target Execution, Human Actor attribution,
status, version, and start/finish timestamps. The finish outcome is a closed enum. Events contain
only those lifecycle identifiers and status metadata.

The request idempotency hash binds only the metadata above. A retry of an already accepted key
returns the original Action and never writes either the old or newly supplied transient bytes again.
Consequently, callers must use a new idempotency key for a deliberate second submission.

### Ordering and uncertainty

Secret delivery preserves ADR-0011 ordering:

1. atomically commit the metadata-only Action, `ACTIVE` sensitive state, and accepted Event;
2. commit a metadata-only `interaction.write_attempted` Event;
3. synchronously enable sensitive-output redaction inside the PTY Executor and call `pty.write()`
   exactly once;
4. commit `DELIVERED`, or `UNKNOWN` when the adapter result is uncertain.

Redaction must be enabled in the Executor method that performs the write. Enabling it later in the
Application callback would leave a race in which an echoed secret reaches Executor rings. A failure
after step 2 is never replayed. Redaction remains active until an exact Human finish succeeds.

The finish transition is committed before the Executor disables redaction. A database failure
therefore retains the safer active mode. If the Runtime loses the PTY, normal fencing/recovery rules
mark the generation broken and never recreate or replay the secret.

### One sanitized stream for every observer

While the period is active, the Executor must transform PTY data before it reaches either bounded
output ring or `onOutput`. All PTY data is suppressed by a streaming sanitizer; the Executor emits
one fixed redaction notice whose size is independent of the hidden output. Parser state still spans
callbacks so future safe extensions cannot mishandle an ANSI control string split across chunks.
The same sanitized stream is then used for:

- active Execution and Session output rings;
- Event payload and `search_text`;
- Artifact content;
- Virtual Screen and Human Console stream;
- ordinary application logs or recordings that consume Runtime output.

There is no privileged raw-output recording path. Redaction is irreversible. Sanitizer state spans
PTY chunks so an ANSI control string split across callbacks cannot leak payload fragments. Unknown
or incomplete escape syntax is handled fail-closed. Before redaction ends, the Executor also
discards any partial command-barrier prefix retained by its PTY parser so active-period bytes cannot
cross the boundary and become visible in a later callback.

The Virtual Screen is a redacted observation during and after the period, not a reconstruction of
hidden cells. Consumers must not treat the fixed notice as exact secret text or use it to infer
secret length.

### Scope of the guarantee

This decision prevents the submitted request bytes and raw output observed during the active period
from entering normal Runtime persistence and observation surfaces. It does not erase terminal text
recorded before activation, protect another process outside this PTY, inspect OS swap/core dumps, or
taint-track a program that deliberately prints a remembered secret after the Human ends redaction.
The compact Console indicator explains this boundary through its accessible label and tooltip.

## Consequences

- Secret input remains an Application Action and retains exact Actor, generation, Execution,
  fencing, admission, and delivery-uncertainty semantics without retaining its content.
- Audit can prove who opened and closed a sensitive period and whether delivery was attempted, but
  cannot recover the secret or its length.
- Human disconnects may leave a generation intentionally redacted until the same Human reconciles
  it; availability is subordinate to avoiding accidental disclosure.
- Output search, Artifacts, Execution results, and screenshots lose content generated during the
  period by design.
- Console/RPC request bodies still hold the secret transiently in process memory; handlers must not
  log bodies, validation errors, or request hashes containing it.

## Rejected alternatives

- **Password input plus ordinary InputAction:** hides browser glyphs but persists the secret in the
  Action payload and may persist its echo in every output surface.
- **Redact only Events or Artifacts:** leaves Executor rings, Execution results, and Virtual Screen
  copies intact.
- **Infer activation from a password-like prompt:** terminal text is spoofable and cannot authorize
  a Human-only operation.
- **Automatically stop on disconnect, timeout, or Execution exit:** a delayed echo could then become
  durable without an explicit Human safety decision.
- **Keep an encrypted recoverable secret payload:** introduces key custody and offline-guessing risk
  without helping PTY delivery semantics; this channel deliberately retains no secret material.
