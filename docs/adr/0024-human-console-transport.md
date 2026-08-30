# ADR-0024: Human Console as a loopback HTTP/WebSocket Runtime adapter

- Status: Accepted for M5
- Date: 2026-08-30

## Context

M5 needs the first real Human Console without introducing a second terminal owner or a browser-only write path. The Runtime daemon already owns the live PTY, Application state transitions, durable Events, Virtual Screen, and generation-scoped Interaction Guard. The Console therefore needs transport and presentation semantics, not another execution model.

The browser also needs reconnect behavior. A WebSocket is transient and cannot become truth: output can outlive a connection, screen revisions are bounded, and a Runtime restart destroys the live PTY even though PostgreSQL facts remain.

## Decision

### Process and trust boundary

`apps/console` is a separate loopback-only Fastify process. It connects to the Runtime daemon through `RuntimeGateway`, normally `UnixRuntimeClient`. It never imports a PTY executor and never writes terminal bytes itself.

The first release accepts only `127.0.0.1`, `::1`, or `localhost` listen hosts. Non-loopback binding is rejected before listen. HTTP Host and WebSocket Origin must name the actual loopback listener. Browser state-changing requests also carry an HttpOnly, SameSite=Strict Console session cookie plus a same-origin request header. Tokens never appear in URL query strings.

The server creates one stable Human Actor per Console cookie. Request bodies cannot supply or override Actor identity. This is trusted-local identity, not remote authentication; remote exposure remains prohibited until M10 capability/authentication work.

### HTTP commands

HTTP exposes bounded JSON resources for Session create/list/get/close, Execute, Input, Control, Event query, screen snapshot, interaction state, policy change, and Guard acquire/renew/release.

- READY command submission calls `startExecute`; there is no READY raw-input endpoint.
- RUNNING Input/Control requires the exact generation and target Execution and calls the same Application service as MCP.
- Every Execute/Input/Control request carries a caller-generated idempotency key.
- Console responses distinguish accepted Action state from Execution completion.
- Runtime errors preserve code/details/retryability and add request id plus transport-level allowed-next-action hints.

### WebSocket synchronization

The WebSocket carries observation only. Its URL identifies Session and generation; credentials remain in the cookie. The first frame is a bounded synchronization bundle:

- current live Session;
- current InteractionState;
- current 120x40 Virtual Screen snapshot;
- durable Events after the client cursor;
- resulting durable cursor and screen version.

Subsequent frames contain bounded Event pages and a current screen snapshot after a reactive screen-version wait. The client acknowledges its latest durable cursor and screen version. A reconnect presents those values again. If an Event cursor or retained screen revision cannot resume, the server sends `resync_required` with a full live snapshot and explicit live-gap metadata; it never fabricates missing history.

Per-connection pending bytes and update cadence are bounded. A slow consumer receives `resync_required` and the connection closes instead of accumulating unbounded memory. Closing a socket aborts its current reactive wait.

### Human interaction mode

The React page renders the canonical Virtual Screen through xterm.js at fixed 120x40 geometry.

- READY focuses a separate command composer and submits an ExecuteAction on Enter.
- RUNNING may enter interactive focus. Browser key data is grouped into a 20 ms batch before one InputAction.
- The page acquires a 500 ms Human Guard before a raw-key burst, renews only within ADR-0023 bounds, and releases after idle, blur, or explicit focus exit.
- WebSocket disconnect triggers best-effort server-side release for a Guard held by that Console Actor. TTL remains the safety boundary when release cannot be confirmed.
- Ctrl+C is an explicit TTY ControlAction; emergency Guard bypass stays a separate Human-only control option.

### Rendering and truth

The headless Runtime projection is canonical. The first Console reconstructs bounded plain screen text and cursor position into xterm.js; it does not claim browser/headless style parity or resize ownership. Timeline attribution comes from durable Events, never from parsing terminal text.

## Consequences

- Human and Agent use different transports but exactly one Application/Runtime write boundary.
- Browser refresh and WebSocket reconnect can resume durable facts and explicitly resynchronize live screen state.
- Console process loss cannot orphan a permanent input lock.
- Fixed geometry avoids multi-viewer resize races but leaves responsive reflow and style parity to later M6 work.
- The trusted-local cookie is intentionally insufficient for remote or hostile multi-user deployment.

## Rejected alternatives

- **WebSocket writes directly to node-pty:** bypasses Actions, durability, policy, and stale-target checks.
- **One WebSocket owns the terminal:** recreates permanent ownership and abandoned-lock recovery.
- **Send Actor in every request body:** lets browser code impersonate Human/Agent/System identities.
- **Use query-string bearer tokens:** leaks credentials through history, logs, referrers, and copied URLs.
- **Replay raw PTY output after reconnect:** durable output and live VT state have different retention and cannot safely reconstruct arbitrary terminal state.
- **Let browser resize the PTY:** introduces multi-viewer geometry races before ownership/reflow semantics exist.
