# ADR-0066: Human-local foreground line drafts

- Status: Accepted
- Date: 2026-09-04
- Amends: ADR-0024, ADR-0065

## Decision

Human and Agent ordinary foreground commands are both complete-line submissions. Console
RUNNING input defaults to a local textarea at the canonical cursor, not xterm raw key forwarding.
Draft editing, IME, paste and backspace generate no InputAction and acquire no Human Guard.
Agent input and asynchronous output may proceed while the Human edits. Drafts are scoped to
Session/generation/Execution, stay only in browser memory and never enter shared observations.

On Enter the Console observes the exact target's input/interaction context and submits one
printable LF-terminated line via the existing lineInput contract. Concurrent submitted Actions
remain serialized; CAS conflicts preserve the local draft for a fresh Human decision. Unknown
submission disables resubmission of that draft scope until explicit reconciliation outside this
UI; transport failure never creates an automatic second intent. Agent output cannot replace the
Human draft, nor may an old response clear a different target's draft. Multiline foreground paste
is preserved locally and rejected as a line submission rather than flattened or auto-executed.
READY multiline Shell Execute semantics are unchanged.

Raw/TUI interaction is an explicit Advanced choice, reset for a new Execution. Only raw mode
forwards individual keys and acquires the existing short Human Guard. Ctrl+C/D/Z remain explicit
ControlActions; detected password input remains the Human-only secret channel. Switching modes
never automatically submits the draft. This is a product distinction, not a heuristic claim that
arbitrary terminal applications all implement newline command input.

BS/DEL in legacy/raw line input are treated as pending edits; a successfully delivered newline
clears pending without trying to count the program's actual buffer. Unsupported raw controls
still produce unknown, now distinguished from uncertain delivery in InputContext. No Human
confirmation/reset API is introduced. Raw-mode uncertainty cannot be bypassed by merely switching
the UI to line mode, and delivery uncertainty remains sticky through later writes.

## Rollout

Deploy Console and Runtime together with explicit coordination if foreground programs are live.
Old Runtime instances do not acquire new semantics through a browser refresh. No database rows,
Action outcomes, unknown delivery, or live PTYs are rewritten to claim recovery.
