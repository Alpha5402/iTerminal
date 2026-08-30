# M4 MCP stdio protocol

M6.1–M6.6 extend this protocol with bounded screen observation, synchronization, stable styled-cell metadata, generation-scoped interaction policy, and controlled terminal geometry while preserving the M4 Action and Event contracts.

iTerminal uses the official Model Context Protocol TypeScript SDK v2 and `serveStdio`. The bridge logs only to stderr because stdout is the MCP framing channel. A separate Runtime daemon owns all live state; set `ITERM_RUNTIME_SOCKET` to its absolute Unix socket path before starting the bridge.

The daemon has two explicit storage modes:

- Without `ITERM_DATABASE_URL`, it is a development-only in-memory live Runtime.
- With `ITERM_DATABASE_URL`, Execute/Input/Control/Resize admission, interaction policy/Guard state, and lifecycle facts are committed to PostgreSQL, PTY output enters a bounded per-Session ingest loop, and `events_query` reads the durable Event stream.

In both modes the PTY remains process-local live truth. Restart recovery marks the previous stable owner generation `BROKEN` and ambiguous work `UNKNOWN`; it never rebuilds a fake live Session from rows.

## Actor configuration

One bridge process represents one Agent Actor:

| Environment variable    | Default                      |
| ----------------------- | ---------------------------- |
| `ITERM_ACTOR_ID`        | process-scoped `agent_<pid>` |
| `ITERM_ACTOR_PRINCIPAL` | `local-agent`                |
| `ITERM_ACTOR_CLIENT`    | `mcp-stdio`                  |

The Actor type is always `agent` in M4. Tool arguments cannot claim to be Human or another principal. Authentication and policy hardening remain later work.

## Tools

| Tool              | Result/behavior                                                                       |
| ----------------- | ------------------------------------------------------------------------------------- |
| `session_create`  | Starts one persistent bash/zsh PTY at an existing workspace                           |
| `session_get`     | Returns current live projection and active Execution                                  |
| `session_list`    | Lists daemon-owned Sessions                                                           |
| `session_close`   | Terminates the exact generation's PTY/process group                                   |
| `execute`         | Returns accepted Action and DISPATCHING/RUNNING Execution immediately                 |
| `execution_get`   | Reads current bounded Execution projection                                            |
| `execution_wait`  | Waits for a terminal Execution state without replay                                   |
| `interaction_get` | Reads exact-generation policy, state version, and active short Human Guard            |
| `input`           | Writes one batch to an exact generation/Execution, optionally screen-version guarded  |
| `control`         | Delivers explicit TTY control bytes or process-group signal                           |
| `terminal_resize` | Applies one guarded, geometry-versioned resize to the shared PTY and Virtual Screen   |
| `events_query`    | Returns at most 500 Events after a generation-scoped sequence                         |
| `screen_get`      | Returns the bounded live ANSI/VT viewport, cursor, buffer, and screen version         |
| `screen_region`   | Reads a bounded rectangle using zero-based terminal-cell coordinates                  |
| `screen_cells`    | Reads sparse material cells with palette/RGB colors and standard SGR attributes       |
| `screen_diff`     | Returns retained row replacements or an explicit full-snapshot resync                 |
| `screen_search`   | Searches literal text in the current viewport with bounded terminal-cell coordinates  |
| `screen_wait`     | Reactively waits for text, version, stability, or an exact Execution's terminal state |

Every successful tool result contains a JSON text block and `structuredContent: { result }`. Domain failures are tool-level errors with a JSON text envelope:

```json
{
  "error": {
    "code": "PTY_BUSY",
    "message": "Session already has an active ExecuteAction",
    "details": {
      "activeExecutionId": "exe_...",
      "availableActions": ["wait", "send_input", "control", "fork_session"]
    },
    "retryable": true
  }
}
```

`execute`, `input`, `control`, and `terminal_resize` require caller-generated idempotency keys. The namespace is one Session + Actor across all Action kinds, so reusing a key for another kind or payload returns `IDEMPOTENCY_KEY_REUSED`. A transport disconnect after a mutating RPC returns `DELIVERY_UNKNOWN`; inspect state using the same idempotency key or Events before any deliberate retry.

`terminal_resize` takes `columns`, `rows`, and the exact `expectedGeometryVersion` observed from `screen_get`. Geometry starts at 120×40/version 1 and is bounded to 40–240 columns by 12–100 rows. A stale CAS returns retryable `GEOMETRY_CHANGED` before creating an Action. Human/Agent resize follows the same policy and Human Guard as Input/Control; Scheduler/System remain denied. A confirmed resize increments both geometry and screen versions. Once `terminal.resize_write_attempted` exists, any unconfirmed PTY/projection outcome becomes Action `UNKNOWN` plus generation `BROKEN` and is never automatically replayed.

Every generation starts with `human_guarded`, interaction state version `1`, and no Guard. `common` allows Human/Agent interaction; `human_only` and `agent_only` admit only the named Actor type; Scheduler/System interaction is denied until explicit capability policy exists. A short Human Guard under `human_guarded` blocks other Actors with retryable `INPUT_GUARDED`; policy denial is non-retryable `POLICY_DENIED`. The MCP bridge is always an Agent and exposes only `interaction_get`: policy changes and Guard acquire/renew/release are Human/System Runtime RPC operations, not Agent tools. MCP `control` cannot request emergency Guard bypass.

Guard expiry is bounded and versioned, not ownership: default TTL is 500 ms, accepted range is 50 ms–5 s, and one Guard may renew at most three times. Clients re-read `interaction_get` after `INPUT_GUARDED` or an uncertain mutation. They never replay Input/Control merely because a Guard expired.

`BACKPRESSURE` means the durable delivery backlog is at its configured bound. No new Action or Session reservation was created, the READY Session remains usable, and the caller may retry the same request/idempotency key after Outbox capacity drains. `RUNTIME_UNAVAILABLE` instead means the durable journal or Runtime boundary is unhealthy; callers must inspect/reconnect rather than assuming the old PTY survived.

`screen_search` and `screen_wait` observe only the live current viewport; neither scans scrollback nor durable Events. A wait timeout is bounded to 1–300,000 ms and returns `matched: false`, `reason: "timeout"`, and the latest snapshot instead of raising a transport error. A stable condition means only that no `screenVersion` was applied during its interval—it does not prove prompt readiness or command completion. If an RPC client disconnects, the daemon aborts that client's server-side wait.

`screen_region` validates that the requested row/column rectangle fits the current canonical geometry. Coordinates and widths are terminal cells, not JavaScript string offsets; a wide glyph clipped by either region edge is represented as blank space. `screen_diff` retains 64 process-local revisions and returns bounded complete-row replacements plus current frame metadata. A future or evicted `afterVersion` returns `resyncRequired: true` with the current full snapshot. A diff crossing resize returns the same shape with reason `geometry_changed`; clients must replace their whole viewport instead of applying old coordinates. The ring is not durable and cannot resume a lost PTY generation.

`screen_cells` uses the same bounded rectangle and returns row-major material cells tied to one exact current frame. Default blank cells and wide-character continuations are omitted; styled blanks remain present. Default colors are omitted, while non-default colors use explicit palette indexes or RGB channels. Enabled bold, italic, dim, underline, blink, inverse, invisible, strikethrough, and overline attributes appear as `true`. An invisible cell retains width/style but returns empty visual text; concealed characters are also excluded from snapshots, regions, search, and plain-text diffs. Hyperlink targets, underline variants/colors, images/sixel, pixel metrics, and style diffs are not exposed by this contract.

## Run locally

Use two terminals:

```bash
ITERM_DATABASE_URL=postgresql://iterminal@127.0.0.1:5432/iterminal \
  ITERM_RUNTIME_SOCKET=/tmp/iterminal.sock pnpm daemon
ITERM_RUNTIME_SOCKET=/tmp/iterminal.sock pnpm mcp
```

The second command is normally launched by an MCP Client, not by a Human directly. The official SDK v2 serving guide documents `serveStdio` and the requirement that logs stay off stdout: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md>.
