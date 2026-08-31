# Human Console security operations

M10.8 and M10.11 keep the first Human Console inside one trusted local OS-user boundary. It is not a remote
administration endpoint and must not be exposed through `0.0.0.0`, a LAN address, port forwarding,
or a reverse proxy.

## Exact local URL

The default and recommended URL is:

```text
http://127.0.0.1:4173
```

Use that authority exactly. The server rejects alternate loopback names, missing/nonmatching ports,
non-loopback Host values, and a browser Origin whose scheme, hostname, or effective port differs.
For example, a process configured as `127.0.0.1:4173` rejects `localhost:4173` and
`https://127.0.0.1:4173`.

`ITERM_CONSOLE_HOST` may be one `127/8` literal, `::1`, or `localhost`. It is a bind/authority choice,
not an allowlist. Do not set a DNS name even if it currently resolves to loopback.

## Browser request boundary

The shipped page adds `X-ITerminal-Request: console` to every HTTP API request. All `/api/*` HTTP
requests require it, including bootstrap and observation GETs. Mutating requests and every
WebSocket upgrade additionally require an exact same-origin Origin. Fetch Metadata, when supplied
by the browser, must be `none` or `same-origin`.

The `iterminal_console` cookie is opaque, HttpOnly, `SameSite=Strict`, path `/`, and expires after one
day. It maps to a process-local Human Actor; it is not a remote bearer credential. Do not copy it,
place it in a URL, or use browser extensions to export it.

The Console emits `Cache-Control: no-store`, a self-oriented Content Security Policy,
`frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and
`Referrer-Policy: no-referrer`.

## Resource limits

Production defaults are process-local:

| Boundary                     |                         Default |
| ---------------------------- | ------------------------------: |
| HTTP request body            |                           1 MiB |
| WebSocket client message     |                          16 KiB |
| WebSocket pending-send bytes |                           1 MiB |
| Console Actor records        | 256 with 24-hour inactivity TTL |
| Open/handshaking streams     |                              64 |
| Streams per Human Actor      |                               4 |
| API requests                 |              600 per 10 seconds |
| API requests per Actor       |              120 per 10 seconds |

Excess Actor or stream admission returns `BACKPRESSURE`; retry only after closing unused tabs or
waiting for expired Actor records. A malformed WebSocket acknowledgement closes with code `1008`.
An oversized client message closes with `1009`. A slow outbound consumer receives
`resync_required` and closes with retry-later semantics instead of growing an unbounded buffer.

Every API request and WebSocket upgrade enters the fixed request window after exact authority and
browser-header validation. Requests without a currently known cookie Actor share one anonymous
bucket; hostile Cookie values cannot create limiter state. `429 RATE_LIMITED` includes a bounded
scope, millisecond retry delay, and `Retry-After`. Wait for that delay rather than retrying in a tight
loop. This cheap-request limiter is separate from PostgreSQL-authoritative durable Action rate limits.

Library tests may lower Actor/stream limits through `resourceLimits`. The production CLI does not
expose environment overrides in this slice, so an accidental deployment variable cannot silently
remove the defaults.

## Runtime grant remains separate

The browser never receives `ITERM_RPC_GRANT`. The Console process holds the paired-prefix Human
grant and uses it only on the mode-0600 Runtime/Router Unix socket. Continue to follow
[Runtime RPC authentication](../protocol/m10-runtime-rpc-authentication.md) for secret generation,
least-privilege operations, and process configuration.

## Troubleshooting rejection

- `403 POLICY_DENIED` on every request: open the exact URL printed by the Console process; check for
  scheme, alias, or port drift and remove reverse proxies.
- `403 INVALID_REQUEST` on API GET/POST: use the shipped frontend or add
  `X-ITerminal-Request: console` in an intentional local diagnostic client.
- `401 POLICY_DENIED`: bootstrap through the shipped page so the server can issue a current cookie.
- `503 BACKPRESSURE`: close stale tabs. Do not raise limits before measuring the number and owner of
  open local connections.
- `429 RATE_LIMITED`: honor `Retry-After`; repeated bootstrap/observation polling or a reconnect
  loop is exceeding the local fixed window.
- WebSocket `1008`/`1009`: fix the client acknowledgement schema or payload size; do not reconnect
  the same invalid frame in a loop.

Ingress errors deliberately do not echo Host, Origin, cookies, bodies, grants, query values,
caller-supplied request IDs, invalid workspace paths, filesystem diagnostics, or unknown exception text. The Console generates its own response
request ID. The production default disables the Fastify logger; if an embedding enables it, request
URL/Host metadata must be treated as potentially sensitive. Repository-wide log/token redaction and
custom logger review remain separate M10 work.

## Not a security claim

This boundary does not protect against hostile code running as the same OS user, browser compromise,
extensions with local-network privileges, process-memory/environment inspection, kernel compromise,
or an administrator deliberately proxying the port. It is local browser ingress hardening, not a
sandbox or remote authentication system.
