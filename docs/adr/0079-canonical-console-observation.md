# ADR 0079: Canonical Console cells and bounded observation

Status: Accepted

The Console receives a canonical full cell frame via `screen.frame`, bounded by the existing
240 × 100 geometry. This read has its own RPC grant operation and exact generation validation.
Cells, cursor, geometry and text come from one projection read; the legacy 120 × 40 rectangle
contract stays unchanged. Normalized text is rendered using only generated cursor and SGR
sequences. Raw PTY escape sequences are never replayed into the browser.

Screen versions and durable event cursors describe separate observations. A stream must state
partial persistence availability instead of delaying all screen reads on journal flushes. Full
frames remain the correctness fallback on reconnect or a missing delta baseline. Screen delivery
may coalesce; durable events may only advance after their page is delivered, never by dropping
intermediate facts. Client screen ACKs do not acknowledge PostgreSQL persistence.

Normal-buffer history is bounded observation, scoped to generation and geometry epoch. It is
not an execution transcript or a durable archive. Alternate screens do not append frame snapshots
to history. History eviction or geometry reflow invalidates old cursors explicitly.

The styled WS path permits one unacknowledged screen frame and retains only the newest pending
frame. Events continue by cursor while a screen ACK is outstanding. If the render ACK does not
arrive within five seconds, the connection requests resynchronization and closes; reconnect starts
with a full frame. The default screen send ceiling is 30 fps (composition option 1–60 fps). This
bounds server-side frame retention and the browser render queue without treating ACK as durability.

Canonical cell frames are captured on consumer demand and cached for one applied screenVersion.
The existing serialized projection read lane provides single-flight capture. Callers receive
independent copies. ADR 0021's 64 plain-text snapshots per applied revision are preserved; this
optimization does not discard intermediate applied versions or change terminal-response ordering.
