# ADR 0019: Live virtual screen projection

- Status: Accepted for M6.1
- Date: 2026-08-30

## Context

`Session.screenVersion` currently advances for each visible PTY output chunk, but the Runtime exposes only raw output Events and bounded per-Execution capture. An Agent cannot ask what a terminal currently displays after cursor movement, line erasure, wrapping, or alternate-screen transitions. Replaying Events in every client would duplicate terminal-emulation semantics and make Human and Agent views disagree.

The PTY already starts at 120 columns by 40 rows. This is the only geometry the current Runtime owns; no client resize protocol exists yet.

## Decision

- The Runtime owner maintains one process-local virtual screen per live Session generation.
- `@xterm/headless` 6.0.0 performs ANSI/VT parsing. Its headless buffer reader requires `allowProposedApi`; iTerminal confines that experimental API behind one pinned adapter and an Application port so domain and RPC packages do not depend on xterm.js.
- PTY output is sent to the durable Event ingest path and the screen projection from the same Runtime callback. Projection writes and reads share one serialized lane. A snapshot therefore represents a complete prefix of PTY output, never a partially parsed escape sequence.
- The first slice uses the existing canonical 120x40 PTY geometry and returns the active viewport as bounded plain-text rows, the active normal/alternate buffer identity, zero-based cursor coordinates, and the exact applied `screenVersion`.
- `screen.get` requires an exact Session generation. It is a read-only live operation available through Runtime RPC and MCP as `screen_get`.
- Virtual screen state is process-local live truth. PostgreSQL Event history remains durable observed truth; daemon restart does not reconstruct or claim to resume a lost screen/PTY.

## Consequences

- Agents can observe cursor-addressed and alternate-screen programs without receiving an unbounded raw transcript.
- A future Human Console can use the same Runtime projection instead of independently guessing screen state.
- Plain text does not yet preserve color/style, hyperlinks, images, or sixel data. Region/diff/search, wait predicates, resize/reflow, durable snapshots, and screen resynchronization remain later M6 slices.
- The xterm headless API is documented as experimental. The dependency is pinned exactly and its projection contract is covered by deterministic tests before any version change.
- Fixed geometry deliberately avoids treating whichever viewer connected last as the PTY resize authority.
