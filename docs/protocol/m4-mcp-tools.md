# M4 MCP stdio protocol

M6.1–M7.2 extend this protocol with bounded screen observation, synchronization, stable styled-cell metadata, generation-scoped interaction policy, controlled terminal geometry, advisory terminal-state evidence, versioned checkpoint fork, and same-owner durable rebuild while preserving the M4 Action and Event contracts.

iTerminal uses the official Model Context Protocol TypeScript SDK v2 and `serveStdio`. The bridge logs only to stderr because stdout is the MCP framing channel. Separate Runtime daemons own all live state; set `ITERM_RUNTIME_SOCKET` to one daemon's absolute Unix socket or, for M9 multi-owner routing, the stable Router socket before starting the bridge.

The daemon has two explicit storage modes:

- Without `ITERM_DATABASE_URL`, it is a development-only in-memory live Runtime.
- With `ITERM_DATABASE_URL`, Execute/Input/Control/Resize admission, interaction policy/Guard state, Shell Checkpoints, Session fork lineage/idempotency, and lifecycle facts are committed to PostgreSQL, PTY output enters a bounded per-Session ingest loop, and `events_query` reads the durable Event stream.

In both modes the PTY remains process-local live truth. Restart recovery marks the previous stable owner generation `BROKEN` and ambiguous work `UNKNOWN`; a PostgreSQL-backed daemon may expose a bounded same-owner `BROKEN` rebuild projection, but it has no Executor, screen, or fake READY state.

## Runtime owner registry boundary

A PostgreSQL-backed daemon registers its stable logical `ownerId`, boot-unique `instanceId`, monotonic registry epoch, and absolute Unix socket before durable owner recovery. It then heartbeats with PostgreSQL time. A second live incarnation of the same logical owner remains unavailable and cannot reconcile or break the first daemon's Sessions. Graceful shutdown moves the row through `DRAINING` to `STOPPED`; losing the exact registry identity is an owner-wide durability failure that closes local PTYs and rejects RPC admission.

The registry is discovery and lifecycle state, not a Session lease. Registry epoch protects only registry-row updates. M9.2's stateless Router uses PostgreSQL to select an ACTIVE owner for `session.create`, route exact Session/Execution operations to an ACTIVE or DRAINING owner, and fail closed when a route is missing, stopped, expired, or unreachable. It reuses the Runtime RPC protocol and never owns a PTY.

`OWNER_ROUTE_UNAVAILABLE` means routing failed before a usable owner result was obtained. An exact target that exists without a live route is not recreated. If a mutating forward may have reached the registered endpoint, the result remains `DELIVERY_UNKNOWN`; the Router does not retry it.

M9.3 adds a separate generation-scoped Session lease. Root/fork creation acquires it for the exact owner instance; the daemon renews only its in-memory exact fence set, and lease expiry never exceeds owner expiry. Every live durable mutation validates owner ID, boot instance, registry epoch, Session ID, generation, and fencing token in its PostgreSQL transaction. Execution transitions additionally compare their own expected version. `SESSION_LEASE_LOST` is non-retryable because PTY bytes may already have been written; it trips the owner-wide circuit and closes local PTYs best-effort. Recovery marks the old generation `BROKEN`, ambiguous Execution state `UNKNOWN`, and rebuilds only as a new Session—never as live PTY takeover.

M9.4 replaces Router-side list-and-pick with an atomic PostgreSQL placement claim. New root Sessions are assigned by monotonic attempt count across unexpired ACTIVE owners; DRAINING owners serve only exact existing routes. This is deterministic round-robin fairness, not capacity or active-load scheduling.

M9.5 validates the same contracts with an independent Router process and three independent Runtime processes. Router restart is stateless. After Runtime `SIGKILL`, exact targets fail closed until owner-lease expiry; a boot-unique same-owner replacement advances registry epoch, exposes only bounded `BROKEN` Session reconstruction evidence, and creates a new PTY only for a newly placed Session. Historical durable `UNKNOWN` Executions are not reconstructed as fake live Execution objects. Graceful `SIGTERM` drains, closes local Sessions, releases leases, and persists `STOPPED`.

M9.6 isolates one Runtime's PostgreSQL path behind a silent blackhole. Its query deadline trips only that owner's durability circuit, closes local PTYs, and lets its registry lease expire while the Router and healthy owners continue exact routing and placement. Recovery resets timed-out TCP streams before reconnecting; Pool and checked-out Client error listeners prevent late transport errors from terminating the process without changing query-rejection semantics. Re-registering the same boot incarnation may retain its registry epoch, but old Sessions remain `BROKEN`, ambiguous Executions remain `UNKNOWN`, and only a distinct new Session may own a new PTY.

M9.7 makes two Router crash boundaries explicit. A placement claim committed before owner forwarding remains a consumed attempt even if no Session is created. A successful owner mutation whose Router response is lost remains owner-authoritative; the Router never retries it across owners. The client observes `DELIVERY_UNKNOWN` and may settle an idempotent operation such as `execution.start` only with its original identity and idempotency key.

M9.8 gives root `session.create` its own global idempotency key and durable placement intent. M9.9 keeps a database-partitioned Router fail closed without cached routing. M9.10 lets the production Router bind its local socket in `CONNECTING`, retry migration in the background, and expose route-phase `RUNTIME_UNAVAILABLE` until PostgreSQL is READY. A raw route-query failure returns the gate to `UNAVAILABLE`; healthy Routers and owners remain independent. M9.11 bounds caller-controlled root-creation keys with one PostgreSQL policy shared by every Router and trusted-local Runtime fallback. Active Sessions and work still owned by an exact live incarnation remain pinned; only retained terminal/stale work is cleaned. M9.12 makes graceful drain settle placement committed before `DRAINING`: the Runtime keeps RPC available while exact-owner unfinished root-create intents remain, then gracefully drains accepted responses before closing Sessions and persisting `STOPPED`. One deadline bounds both phases. Timeout does not move the intent to another owner or claim successful delivery.

| Environment variable                  | Default                         |
| ------------------------------------- | ------------------------------- |
| `ITERM_RUNTIME_OWNER_ID`              | derived from the Runtime socket |
| `ITERM_RUNTIME_OWNER_INSTANCE_ID`     | random boot-unique UUID         |
| `ITERM_RUNTIME_OWNER_LEASE_MS`        | `15000`                         |
| `ITERM_SESSION_LEASE_MS`              | `15000`                         |
| `ITERM_RUNTIME_DRAIN_TIMEOUT_MS`      | `5000`                          |
| `ITERM_DATABASE_HEALTH_CHECK_MS`      | `1000`                          |
| `ITERM_DATABASE_RECONNECT_INITIAL_MS` | `250`                           |
| `ITERM_DATABASE_RECONNECT_MAX_MS`     | `30000`                         |
| `ITERM_DATABASE_STATEMENT_TIMEOUT_MS` | `30000`                         |
| `ITERM_ACTOR_ACTION_RATE_LIMIT`       | `120`                           |
| `ITERM_SESSION_ACTION_RATE_LIMIT`     | `240`                           |
| `ITERM_ACTION_RATE_LIMIT_WINDOW_MS`   | `1000`                          |

The owner and Session leases must each exceed two database health-check intervals. Session expiry is capped at the current owner lease expiry. The drain timeout is one shared budget for pending root-create settlement and accepted RPC response drain; expiry proceeds to Session closure without reassigning exact-owner work. The production Runtime Router uses the health/reconnect/statement-timeout values for degraded startup and recovery. These settings are valid only with `ITERM_DATABASE_URL`.

## Actor configuration

One bridge process represents one Agent Actor:

| Environment variable    | Default                      |
| ----------------------- | ---------------------------- |
| `ITERM_ACTOR_ID`        | process-scoped `agent_<pid>` |
| `ITERM_ACTOR_PRINCIPAL` | `local-agent`                |
| `ITERM_ACTOR_CLIENT`    | `mcp-stdio`                  |

The Actor type is always `agent` in M4. Tool arguments cannot claim to be Human or another principal. Authentication and policy hardening remain later work.

## Tools

| Tool                 | Result/behavior                                                                       |
| -------------------- | ------------------------------------------------------------------------------------- |
| `session_create`     | Idempotently starts one persistent bash/zsh PTY at an existing workspace              |
| `session_get`        | Returns current live projection and active Execution                                  |
| `session_list`       | Lists daemon-owned Sessions                                                           |
| `session_close`      | Terminates the exact generation's PTY/process group                                   |
| `session_checkpoint` | Reads bounded latest checkpoint metadata without environment values                   |
| `session_fork`       | Rebuilds a new Session from an exact checkpoint version with stale acknowledgement    |
| `execute`            | Returns accepted Action and DISPATCHING/RUNNING Execution immediately                 |
| `execution_get`      | Reads current bounded Execution projection                                            |
| `execution_wait`     | Waits for a terminal Execution state without replay                                   |
| `interaction_get`    | Reads exact-generation policy, state version, and active short Human Guard            |
| `input`              | Writes one batch to an exact generation/Execution, optionally screen-version guarded  |
| `control`            | Delivers explicit TTY control bytes or process-group signal                           |
| `terminal_resize`    | Applies one guarded, geometry-versioned resize to the shared PTY and Virtual Screen   |
| `events_query`       | Returns at most 500 Events after a generation-scoped sequence                         |
| `screen_get`         | Returns the bounded live ANSI/VT viewport, cursor, buffer, and screen version         |
| `screen_region`      | Reads a bounded rectangle using zero-based terminal-cell coordinates                  |
| `screen_cells`       | Reads sparse material cells with palette/RGB colors and standard SGR attributes       |
| `screen_diff`        | Returns retained row replacements or an explicit full-snapshot resync                 |
| `screen_search`      | Searches literal text in the current viewport with bounded terminal-cell coordinates  |
| `screen_wait`        | Reactively waits for text, version, stability, or an exact Execution's terminal state |
| `terminal_state`     | Classifies one exact-generation live frame with bounded evidence and limitations      |

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

`session_create` requires a caller-generated global creation idempotency key. After `DELIVERY_UNKNOWN`, repeat the exact key, shell, and workspace to retrieve the original durable Session; a changed request returns `IDEMPOTENCY_KEY_REUSED`. Concurrent Routers converge on one placement and Session for that key. The database defaults to retaining at most 100,000 requests for a minimum of 24 hours and cleaning at most 1,000 eligible rows during one new admission. Operators change the singleton `session_creation_policies` row, not individual Router environment variables. Completed active Sessions and unfinished requests whose exact owner is live are not eligible. Once terminal/stale retention expires and cleanup removes a key, using it again is explicitly a new creation request and may produce a different Session/PTTY. Development-only in-memory mode retains settled keys for the process lifetime and is not a hostile-client boundary.

`execute`, `input`, `control`, and `terminal_resize` also require caller-generated idempotency keys. Their namespace is one Session + Actor across all Action kinds, so reusing a key for another kind or payload returns `IDEMPOTENCY_KEY_REUSED`. A transport disconnect after a mutating RPC returns `DELIVERY_UNKNOWN`; inspect state using the same idempotency key or Events before any deliberate retry.

`terminal_resize` takes `columns`, `rows`, and the exact `expectedGeometryVersion` observed from `screen_get`. Geometry starts at 120×40/version 1 and is bounded to 40–240 columns by 12–100 rows. A stale CAS returns retryable `GEOMETRY_CHANGED` before creating an Action. Human/Agent resize follows the same policy and Human Guard as Input/Control; Scheduler/System remain denied. A confirmed resize increments both geometry and screen versions. Once `terminal.resize_write_attempted` exists, any unconfirmed PTY/projection outcome becomes Action `UNKNOWN` plus generation `BROKEN` and is never automatically replayed.

Every generation starts with `human_guarded`, interaction state version `1`, and no Guard. `common` allows Human/Agent interaction; `human_only` and `agent_only` admit only the named Actor type; Scheduler/System interaction is denied until explicit capability policy exists. A short Human Guard under `human_guarded` blocks other Actors with retryable `INPUT_GUARDED`; policy denial is non-retryable `POLICY_DENIED`. The MCP bridge is always an Agent and exposes only `interaction_get`: policy changes and Guard acquire/renew/release are Human/System Runtime RPC operations, not Agent tools. MCP `control` cannot request emergency Guard bypass.

Guard expiry is bounded and versioned, not ownership: default TTL is 500 ms, accepted range is 50 ms–5 s, and one Guard may renew at most three times. Clients re-read `interaction_get` after `INPUT_GUARDED` or an uncertain mutation. They never replay Input/Control merely because a Guard expired.

`BACKPRESSURE` means a durable admission bound is full. Outbox pressure rejects an Action/Session reservation until delivery capacity drains. Root-creation-key pressure returns `component: persistence-postgres`, `phase: idempotency_admission`, `currentRequests`, and `limit`; it rejects a new key before owner selection, placement increment, intent, Session, or PTY. An already retained key remains settleable at capacity. `RUNTIME_UNAVAILABLE` instead means the durable journal or Runtime boundary is unhealthy; callers must inspect/reconnect rather than assuming the old PTY survived.

`RATE_LIMITED` means the durable Actor or Session fixed-window admission bound was exceeded. The error identifies `subjectKind`, `subjectId`, `limit`, `windowMilliseconds`, and `retryAfterMilliseconds`; no Action/state mutation or quota increment commits. Wait for the supplied delay, then retry the identical idempotency key. This is distinct from delivery `BACKPRESSURE`, active-Execution `PTY_BUSY`, and interaction policy/Guard errors. In-memory development mode does not claim distributed rate limiting.

When a central Router cannot query its durable route database, it returns retryable `RUNTIME_UNAVAILABLE` with `component: runtime-router` and `phase: route_resolution` before contacting any owner. This is distinct from `OWNER_ROUTE_UNAVAILABLE`, which means a current durable route exists but its exact owner is absent or unreachable. Clients never infer or cache an owner endpoint across either failure.

`screen_search` and `screen_wait` observe only the live current viewport; neither scans scrollback nor durable Events. A wait timeout is bounded to 1–300,000 ms and returns `matched: false`, `reason: "timeout"`, and the latest snapshot instead of raising a transport error. A stable condition means only that no `screenVersion` was applied during its interval—it does not prove prompt readiness or command completion. If an RPC client disconnects, the daemon aborts that client's server-side wait.

`terminal_state` is an exact-generation, read-only advisory observation. It combines authoritative Session/Execution facts with closed-enum command-family and current-viewport signals, returning `kind`, `confidence`, bounded `evidence`, explicit `limitations`, and the exact screen frame used. It never returns raw command or screen text. Password/confirmation guesses remain low-confidence because terminal text is spoofable and echo mode is not observed; editor/pager/REPL command-family guesses are at most medium-confidence. Clients MUST NOT use this tool alone for authorization, readiness/completion, Approval, secret-channel activation, target selection, automatic input/control, or post-crash reconstruction.

`session_checkpoint` returns the latest exact-generation checkpoint version, content hash, canonical workspace/cwd, Shell, observation age, source status, staleness, and included environment key names. It never returns environment values. The daemon defaults checkpoint capture to `LANG`, `LC_ALL`, and `LC_CTYPE`; operators may set exact additional names with `ITERM_CHECKPOINT_ENV_KEYS`. Credential-like, Runtime-reserved, dynamic-loader, and Shell-startup names plus more than 32 configured keys are rejected; values above 4 KiB or containing newline/NUL are not checkpointed, and malformed control frames fail closed.

`session_fork` requires `expectedCheckpointVersion`, an Actor-scoped idempotency key, and `allowStale: true` for a RUNNING/RESERVED/BROKEN parent. A READY source is re-certified into the next checkpoint version. The child restores only workspace/cwd, Shell kind, and filtered environment; it shares filesystem contents and never copies foreground/background processes, REPL/editor state, descriptors, job control, aliases, functions, or traps. Missing, changed, stale-unacknowledged, or invalid checkpoints fail before a child is admitted. After same-owner restart, the newest bounded valid historical parents are addressable only as `BROKEN` rebuild projections; clients inspect and explicitly fork them into new Session IDs.

`screen_region` validates that the requested row/column rectangle fits the current canonical geometry. Coordinates and widths are terminal cells, not JavaScript string offsets; a wide glyph clipped by either region edge is represented as blank space. `screen_diff` retains 64 process-local revisions and returns bounded complete-row replacements plus current frame metadata. A future or evicted `afterVersion` returns `resyncRequired: true` with the current full snapshot. A diff crossing resize returns the same shape with reason `geometry_changed`; clients must replace their whole viewport instead of applying old coordinates. The ring is not durable and cannot resume a lost PTY generation.

`screen_cells` uses the same bounded rectangle and returns row-major material cells tied to one exact current frame. Default blank cells and wide-character continuations are omitted; styled blanks remain present. Default colors are omitted, while non-default colors use explicit palette indexes or RGB channels. Enabled bold, italic, dim, underline, blink, inverse, invisible, strikethrough, and overline attributes appear as `true`. An invisible cell retains width/style but returns empty visual text; concealed characters are also excluded from snapshots, regions, search, and plain-text diffs. Hyperlink targets, underline variants/colors, images/sixel, pixel metrics, and style diffs are not exposed by this contract.

## Run locally

Direct single-owner development uses two terminals:

```bash
ITERM_DATABASE_URL=postgresql://iterminal@127.0.0.1:5432/iterminal \
  ITERM_RUNTIME_SOCKET=/tmp/iterminal.sock pnpm daemon
ITERM_RUNTIME_SOCKET=/tmp/iterminal.sock pnpm mcp
```

The multi-owner path adds the Router and points adapters at its stable socket:

```bash
ITERM_DATABASE_URL=postgresql://iterminal@127.0.0.1:5432/iterminal \
  ITERM_RUNTIME_OWNER_ID=owner-a ITERM_RUNTIME_SOCKET=/tmp/iterminal-a.sock pnpm daemon
ITERM_DATABASE_URL=postgresql://iterminal@127.0.0.1:5432/iterminal \
  ITERM_RUNTIME_OWNER_ID=owner-b ITERM_RUNTIME_SOCKET=/tmp/iterminal-b.sock pnpm daemon
ITERM_DATABASE_URL=postgresql://iterminal@127.0.0.1:5432/iterminal \
  ITERM_ROUTER_SOCKET=/tmp/iterminal-router.sock pnpm router
ITERM_RUNTIME_SOCKET=/tmp/iterminal-router.sock pnpm mcp
```

An Execution Worker that uses this socket must also set `ITERM_RUNTIME_ROUTING_MODE=router`. Owner mode remains the default and retains its exact owner-ID check.

The second command is normally launched by an MCP Client, not by a Human directly. The official SDK v2 serving guide documents `serveStdio` and the requirement that logs stay off stdout: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md>.
