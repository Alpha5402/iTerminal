# M4 MCP stdio protocol

M6.1 extends this protocol with the read-only `screen_get` tool while preserving the M4 Action and Event contracts.

iTerminal uses the official Model Context Protocol TypeScript SDK v2 and `serveStdio`. The bridge logs only to stderr because stdout is the MCP framing channel. A separate Runtime daemon owns all live state; set `ITERM_RUNTIME_SOCKET` to its absolute Unix socket path before starting the bridge.

The daemon has two explicit storage modes:

- Without `ITERM_DATABASE_URL`, it is a development-only in-memory live Runtime.
- With `ITERM_DATABASE_URL`, Execute/Input/Control admission and lifecycle facts are committed to PostgreSQL, PTY output enters a bounded per-Session ingest loop, and `events_query` reads the durable Event stream.

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

| Tool             | Result/behavior                                                                      |
| ---------------- | ------------------------------------------------------------------------------------ |
| `session_create` | Starts one persistent bash/zsh PTY at an existing workspace                          |
| `session_get`    | Returns current live projection and active Execution                                 |
| `session_list`   | Lists daemon-owned Sessions                                                          |
| `session_close`  | Terminates the exact generation's PTY/process group                                  |
| `execute`        | Returns accepted Action and DISPATCHING/RUNNING Execution immediately                |
| `execution_get`  | Reads current bounded Execution projection                                           |
| `execution_wait` | Waits for a terminal Execution state without replay                                  |
| `input`          | Writes one batch to an exact generation/Execution, optionally screen-version guarded |
| `control`        | Delivers explicit TTY control bytes or process-group signal                          |
| `events_query`   | Returns at most 500 Events after a generation-scoped sequence                        |
| `screen_get`     | Returns the bounded live ANSI/VT viewport, cursor, buffer, and screen version        |

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

`execute`, `input`, and `control` require caller-generated idempotency keys. The namespace is one Session + Actor across all three Action kinds, so reusing a key for another kind or payload returns `IDEMPOTENCY_KEY_REUSED`. A transport disconnect after a mutating RPC returns `DELIVERY_UNKNOWN`; inspect state using the same idempotency key or Events before any deliberate retry.

`BACKPRESSURE` means the durable delivery backlog is at its configured bound. No new Action or Session reservation was created, the READY Session remains usable, and the caller may retry the same request/idempotency key after Outbox capacity drains. `RUNTIME_UNAVAILABLE` instead means the durable journal or Runtime boundary is unhealthy; callers must inspect/reconnect rather than assuming the old PTY survived.

## Run locally

Use two terminals:

```bash
ITERM_DATABASE_URL=postgresql://iterminal@127.0.0.1:5432/iterminal \
  ITERM_RUNTIME_SOCKET=/tmp/iterminal.sock pnpm daemon
ITERM_RUNTIME_SOCKET=/tmp/iterminal.sock pnpm mcp
```

The second command is normally launched by an MCP Client, not by a Human directly. The official SDK v2 serving guide documents `serveStdio` and the requirement that logs stay off stdout: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md>.
