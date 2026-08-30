# M10.8 exact loopback Console ingress verification

**Result: PASS at L3 for exact local Host/Origin browser ingress, bounded HTTP/WebSocket resources,
and compatibility with the real Chrome Human Console plus official MCP Agent shared path.**

Date: 2026-08-31

Platform: macOS arm64, Node.js 22+, pnpm 10.33.2, Google Chrome headless through Playwright,
PostgreSQL 17 Alpine in a disposable local Docker container

## Scope

- Reject non-loopback bind and invalid stream-limit configuration before listen.
- Bind every request to the configured loopback hostname and actual local port.
- Reject alternate loopback aliases, omitted non-default Host ports, and malformed Host authorities.
- Require the custom Console header for every HTTP API request, including bootstrap.
- Reject cross-site Fetch Metadata without allocating a Console Actor.
- Require exact scheme/hostname/port Origin for mutation and WebSocket upgrade.
- Keep cookie and security-header behavior explicit and non-echoing.
- Generate request IDs server-side and suppress raw schema/parser/internal error details.
- Bound Actor records, total/per-Actor streams, HTTP bodies, WebSocket messages, and outbound buffers.
- Close malformed acknowledgements and prove released stream capacity can be reused.
- Re-run the built React page through a real browser against PostgreSQL-backed Runtime and official
  MCP SDK Agent paths.

## Commands and results

```sh
pnpm test:m10:console
```

Result: 1 file and 6 tests passed. Two M10.8 scenarios use real loopback TCP and WebSocket clients;
the existing four scenarios retain real Runtime/node-pty coverage for Actions, Approval, secret
input, Guard disconnect cleanup, and checkpoint rebuild. The Host tests use `node:http` because
standards-compliant `fetch` deliberately prevents overriding Host. The body-parser envelope uses
Fastify injection so an intentional early 413 socket close is not confused with client-side EPIPE.

The ingress scenario verified:

- `localhost:<port>` against a `127.0.0.1:<port>` listener returns 403;
- omitted non-default port returns 403 and `user@<authority>` returns 400;
- a bootstrap without `X-ITerminal-Request` and a `Sec-Fetch-Site: cross-site` bootstrap return 403
  without a cookie;
- HTTPS Origin against the HTTP listener, Origin with a path, and mismatched WebSocket Origin return
  403;
- valid bootstrap returns the HttpOnly, `SameSite=Strict` cookie plus no-store, CSP/frame, and
  content-type security headers;
- caller `X-Request-Id`, unknown schema key/value, malformed JSON, and unknown exception text are not
  reflected; raw Zod issues are not returned;
- a body above 1 MiB returns fixed `413 INVALID_REQUEST` without echoing its sentinel, while invalid
  JSON returns a fixed `400 INVALID_REQUEST`.

The pressure scenario lowered only test-process limits to three Actors, two total streams, and one
stream per Actor. The second same-Actor stream and third global stream returned `503 BACKPRESSURE`;
the fourth bootstrap was also backpressured. Closing one stream admitted the previously rejected
Actor, proving exact release. A malformed acknowledgement closed with `1008`, and a 16 KiB+1 client
message closed with `1009`.

```sh
ITERM_DATABASE_URL=postgresql://iterminal:***@127.0.0.1:<port>/iterminal_test \
  pnpm test:m5:browser
```

Result: the Console production bundle built and 1 file / 4 real-browser tests passed. The shipped
React API helper sent the new header for bootstrap and every observation/mutation GET/POST. A real
headless Chrome Human and official MCP SDK Agent still shared PostgreSQL-backed zsh cwd/env, Python
REPL, Guard, screen, Timeline, Approval, Human-only secret input, and explicit historical rebuild.

```sh
pnpm verify
```

Result: format, lint, typecheck, default test suite, documentation evidence check, TypeScript build,
and Console production build passed. The default suite reported 29 files passed, 32 skipped, 114
tests passed, and 99 skipped; the evidence checker validated 49 milestone reports. The Vite build
retained its advisory warning for a minified chunk larger than 500 kB and completed successfully.

## Not proven

- Remote bind, TLS/reverse proxy, CORS sharing, multi-user authentication, OS-user isolation, or a
  hostile local process/browser extension. The Console remains loopback and same-user only.
- Distributed limits across multiple Console processes or HTTP observation/bootstrap request-rate
  limits beyond Actor/stream/body cardinality.
- Repository-wide Runtime grant/log redaction, Shell marker/path hostile-input review, command
  sandboxing, or filesystem containment.
- Long-duration tab churn, browser matrix beyond local Google Chrome, network-fault injection during
  WebSocket close, or production-scale load testing.
