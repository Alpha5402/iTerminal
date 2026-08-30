# M5 Human Console HTTP/WebSocket protocol

The Human Console is a trusted-local adapter defined by ADR-0024. It never owns a PTY and never accepts an Actor from client JSON. One HttpOnly Console cookie maps to one server-created Human Actor; every write calls `RuntimeGateway`.

## Listener and browser boundary

- Default listener: `127.0.0.1:4173`.
- Allowed bind hosts: `127.0.0.0/8`, `::1`, or `localhost` only.
- Host must be loopback and its explicit port must match the connected listener.
- State-changing HTTP and WebSocket upgrade require an exact same-origin `Origin`.
- State-changing HTTP additionally requires `X-ITerminal-Request: console`.
- `GET /api/bootstrap` creates or resumes the opaque `iterminal_console` HttpOnly, SameSite=Strict cookie. No credential appears in a URL.
- Request bodies cannot select `actor`, `session status`, or Runtime owner.

This boundary prevents ambient web pages and DNS-rebinding hostnames from driving the local Console. It is not remote authentication or multi-user authorization.

## Response envelope

Successful HTTP responses are:

```json
{
  "requestId": "req-1",
  "result": {}
}
```

Failures preserve the Runtime contract and add transport guidance:

```json
{
  "error": {
    "requestId": "req-1",
    "code": "INPUT_GUARDED",
    "message": "Interaction is protected by an active Human Guard",
    "details": {},
    "retryable": true,
    "allowedNextActions": ["observe_interaction", "wait_for_guard_expiry"]
  }
}
```

The HTTP status is only transport guidance. Clients branch on the stable Runtime error code.

## HTTP resources

| Method   | Resource                                                          | Runtime operation and mode                                                |
| -------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET`    | `/api/bootstrap`                                                  | Human Actor, canonical geometry, live Session list                        |
| `GET`    | `/api/sessions`                                                   | `session.list`                                                            |
| `POST`   | `/api/sessions`                                                   | `session.create`; body has `shell`, absolute `workspaceRoot`              |
| `GET`    | `/api/sessions/:id`                                               | `session.get`                                                             |
| `DELETE` | `/api/sessions/:id`                                               | exact-generation `session.close`                                          |
| `POST`   | `/api/sessions/:id/execute`                                       | READY-only `execution.start`; command + idempotency key                   |
| `POST`   | `/api/sessions/:id/input`                                         | RUNNING-only `input.send`; exact Execution and optional screen version    |
| `POST`   | `/api/sessions/:id/control`                                       | RUNNING-only `control.send`; explicit delivery and Guard-bypass audit bit |
| `GET`    | `/api/sessions/:id/events?generation=&after=&limit=`              | bounded durable `events.query`                                            |
| `GET`    | `/api/sessions/:id/screen?generation=`                            | bounded full `screen.get`                                                 |
| `GET`    | `/api/sessions/:id/interaction?generation=`                       | `interaction.get`                                                         |
| `PUT`    | `/api/sessions/:id/interaction`                                   | expected-version `interaction.policy.set`                                 |
| `POST`   | `/api/sessions/:id/interaction/guard`                             | Human Guard acquire                                                       |
| `PATCH`  | `/api/sessions/:id/interaction/guard`                             | exact-holder/version Guard renew                                          |
| `DELETE` | `/api/sessions/:id/interaction/guard`                             | exact-holder/version Guard release                                        |
| `GET`    | `/api/sessions/:id/stream?generation=&after=&afterScreenVersion=` | WebSocket observation upgrade                                             |

READY Input/Control is rejected before Runtime write admission. RUNNING Execute continues to use the Runtime's `PTY_BUSY` result. The Console cannot turn an HTTP success into an Execution-completed claim: Execute returns accepted Action plus the initial Execution projection.

## WebSocket frames

The first frame is `sync`:

```json
{
  "type": "sync",
  "actor": {},
  "session": {},
  "interaction": {},
  "screen": {},
  "events": [],
  "cursor": 42,
  "truncated": false,
  "liveGap": null,
  "eventGap": null
}
```

`update` carries the same bounded Session/interaction/screen/Event projections after a reactive screen wait. The browser acknowledges only observation progress:

```json
{ "type": "ack", "cursor": 42, "screenVersion": 9 }
```

Acknowledgement does not confirm Action delivery and is not durable truth. Browser session storage retains at most 500 Timeline Events plus the last cursor/screen version for reload. Reconnect resubmits those observation positions.

If a durable cursor predates retained history, `eventGap` describes the missing range and the server restarts from retained history. If screen versions differ, `liveGap` accompanies a full canonical snapshot. If a client exceeds the one MiB pending-send boundary, the server sends `resync_required` and closes with retry-later semantics instead of buffering without bound.

## Interactive focus

- READY renders a separate composer; Enter creates one ExecuteAction.
- RUNNING can focus xterm.js; xterm key data is grouped for 20 ms into one InputAction.
- A raw-key burst acquires the 500 ms Human Guard, holds it through a 400 ms idle window, then releases it.
- Ctrl+C/Ctrl+D are explicit TTY ControlActions, not raw READY input.
- Blur, focus exit, WebSocket disconnect, and TTL converge the Guard. Failure to confirm release never triggers automatic Input replay.

The Runtime's headless 120x40 Virtual Screen remains canonical. The browser renders its bounded text/cursor into xterm.js and does not yet claim style parity, resize ownership, scrollback replay, or durable screen reconstruction.
