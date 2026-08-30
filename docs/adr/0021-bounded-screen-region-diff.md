# ADR 0021: Bounded screen regions and revision diffs

- Status: Accepted for M6.3
- Date: 2026-08-30

## Context

M6.1 exposes a complete fixed 120×40 viewport and M6.2 adds current-screen search and reactive waits. A reconnecting viewer or an Agent interested in one pane still has to fetch every row. Treating raw PTY Events as a screen delta is incorrect because VT control sequences can rewrite earlier cells, switch buffers, or move the cursor without appending visible text.

An incremental protocol also needs an explicit loss boundary. The live Runtime must not retain an unbounded snapshot history, and PostgreSQL Events cannot reconstruct the exact headless parser state after the PTY owner is lost.

## Decision

- The Runtime-owned screen projection retains the latest 64 applied viewport revisions per live Session generation, including revision zero. The bound counts revisions, not PTY bytes or durable Events.
- Each applied `screenVersion` records one immutable active-buffer plain-text snapshot after the xterm parser callback completes. History is process-local and is discarded with the PTY generation.
- Runtime RPC and MCP add two exact-generation read operations:
  - `screen.region` / `screen_region` returns a validated rectangular slice using zero-based terminal-cell coordinates. The request is bounded by the canonical 120×40 geometry.
  - `screen.diff` / `screen_diff` compares a retained `afterVersion` with the current revision and returns replacement rows plus current buffer/cursor metadata. At most 40 rows can be returned.
- A diff is row-replacement based, not a stream of ANSI commands or individual-cell patches. Applying every returned row and the current frame metadata produces the current plain-text viewport.
- If `afterVersion` is in the future or is no longer retained, the operation succeeds with `resyncRequired: true`, a reason, and the current full snapshot. It never fabricates missing intermediate deltas or silently treats stale state as current.
- Region slicing preserves terminal-cell geometry. A wide glyph is emitted only when its complete cell span is inside the requested rectangle; a clipped half is represented as blank space. Returned line text is right-trimmed like a full snapshot.
- Region and diff do not expose scrollback, styles, hyperlinks, images, or durable resume tokens.

## Consequences

- Agents can inspect a small pane, and future Human Console reconnect logic can request a compact diff before falling back to the included resync snapshot.
- The fixed revision ring gives deterministic memory usage but may require resync during high-output bursts or slow-client gaps.
- Row replacement intentionally trades minimal wire size for a simple, bounded, verifiable application contract.
- Cell/style diffs, resize/reflow, WebSocket subscription backpressure, durable snapshots, and cross-daemon resume remain later slices.
