# ADR 0020: Reactive bounded screen observation

- Status: Accepted for M6.2
- Date: 2026-08-30

## Context

M6.1 exposes a bounded full viewport, but an Agent waiting for a prompt or screen change would still need to poll `screen_get`. Polling creates avoidable RPC/MCP traffic, can miss the exact freshness boundary used by guarded input, and has no shared definition of “stable”. Raw Event search also cannot answer where visible text currently appears after terminal erasure or alternate-buffer transitions.

## Decision

- The live screen projection exposes a version-change waiter. Parser callbacks notify waiters only after the corresponding PTY chunk is fully applied.
- Runtime RPC and MCP add two exact-generation read operations:
  - `screen.search` / `screen_search` searches only the current active 120×40 viewport and returns bounded row plus terminal-cell column matches tied to one `screenVersion`.
  - `screen.wait` / `screen_wait` waits for one discriminated condition: visible text, version greater than a supplied version, a stable interval with no applied version change, or terminal state of an exact Execution.
- Waits use projection notifications rather than a polling loop. A client-provided timeout is mandatory in the Runtime request, bounded to 1–300,000 ms; MCP defaults it to 30 seconds.
- Timeout is an observed result, not a transport failure: `{ matched: false, reason: "timeout", snapshot }`. A satisfied predicate returns `{ matched: true, reason: "condition", snapshot }` and the terminal Execution for an exit condition.
- “Stable” means only that `screenVersion` did not change for the requested interval. It does not mean Shell ready, command complete, prompt detected, or application idle.
- Closing or breaking the Session invalidates the wait. RPC disconnect aborts the server-side wait; bounded timeout remains a backstop.
- Search never scans scrollback or durable Events. Case-insensitive matching normalizes cell text and the query in the adapter while preserving reported terminal-cell columns.

## Consequences

- Agents can block efficiently on terminal evidence and then use the returned version for freshness-guarded input.
- Search and wait results stay bounded and cannot be mistaken for durable history.
- Text conditions are literal substring matches; regex, fuzzy search, multiline matching, style-aware predicates, and OCR/image protocols remain out of scope.
- Screen diff/region reads, subscription streams, durable waits across daemon restart, and Human Console resynchronization remain later slices.
