# M10.9 credential-safe operational diagnostics verification

**Result: PASS at L2 for opaque Runtime RPC credential representation, fixed RPC failure
boundaries, and credential-free PostgreSQL/RabbitMQ ordinary diagnostics and durable retry text.**

Date: 2026-08-31

Platform: macOS arm64, Node.js 24.15.0, pnpm 10.33.2, real mode-`0600` local Unix sockets and real
failed loopback PostgreSQL/RabbitMQ connection attempts

## Scope

- Keep configured `UnixRuntimeClient`, verified grant, and issued grant bearer values out of
  ordinary enumeration and JSON serialization.
- Preserve Router-to-owner forwarding through an explicit verified-context accessor backed by weak
  storage rather than a public token field.
- Keep missing/tampered authorization failures generic and prevent an active bearer from crossing
  even a known Application `RuntimeError` response.
- Replace raw Zod, unknown server, and client transport exception messages with fixed or code-only
  RPC diagnostics while retaining delivery certainty and request metadata.
- Prevent PostgreSQL/RabbitMQ connection URLs, credentials, query parameters, `cause`, or arbitrary
  thrown strings from entering connection-state callbacks.
- Normalize RabbitMQ connect/publish failures before the Outbox relay persists its retry reason.
- Keep storage-maintenance stderr independent of raw PostgreSQL driver messages.
- Audit current production stderr and Runtime credential references; retain `rpc:grant` stdout as a
  deliberately documented credential channel rather than calling it ordinary telemetry.

## Commands and results

```sh
pnpm test:m10:credentials
```

Result: 5 files and 23 tests passed. The suite exercised real Unix RPC sockets, signed grants,
Router-style verified-context forwarding, actual refused local PostgreSQL/RabbitMQ connections, and
an `OutboxRelay` retry capture. Unique fake credentials embedded in a Runtime bearer, PostgreSQL
password/query, and RabbitMQ password/query were absent from serialized grant/client/issuer values,
RPC errors, connection states, and durable retry input.

```sh
env 'ITERM_DATABASE_URL=postgresql://operator:<sentinel>@127.0.0.1:1/iterminal?token=<sentinel>' \
  pnpm --silent storage:maintain
```

Result: process exited 1 with exactly `Artifact storage maintenance failed` on stderr. The fake
password/query sentinel and raw driver message were absent.

```sh
rg -n 'ITERM_RPC_GRANT|ITERM_RPC_AUTH_SECRET|authorization|\.message|state\.error' \
  apps packages --glob '!**/dist/**'
```

Result: all current Runtime credential reads, request-wire use, state producers, process stderr
sinks, and tests were reviewed. Runtime bearer material appears only in environment ingestion,
sign/verify/forwarding, the bounded Unix request envelope, explicit issuer output, and tests. The
remaining production stderr sinks either print fixed metadata or consume the now-normalized state
values. No ordinary production log call receives a Runtime token, RPC request envelope, raw
PostgreSQL/RabbitMQ connection message, or connection target.

```sh
pnpm verify
```

Result: format, lint, typecheck, default test suite, documentation evidence check, TypeScript build,
and Console production build passed. The default suite reported 32 files passed, 32 skipped, 120
tests passed, and 99 skipped; the evidence checker validated 49 milestone reports. The Vite build
retained its advisory warning for a minified chunk larger than 500 kB and completed successfully.

## Verified behavior

| Boundary                        | Evidence                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-process opacity              | Verified and issued grant objects enumerate claims only; `UnixRuntimeClient` has no enumerable configured socket/token properties; exact bearer sentinels are absent from JSON serialization.                                         |
| Auth and validator failures     | Missing/tampered credentials keep one fixed `POLICY_DENIED`; Zod input failure no longer formats caller-controlled issues.                                                                                                            |
| Known/unknown server errors     | If a known RuntimeError public shape contains the active bearer, the entire public error becomes fixed `RUNTIME_UNAVAILABLE`; unknown exceptions are always fixed.                                                                    |
| Client transport errors         | Read failures remain retryable and mutations remain `DELIVERY_UNKNOWN`; details contain operation, request ID, and fixed context plus at most a closed-allowlist code/SQLSTATE, never `Error.message`.                                |
| PostgreSQL state                | A real refused endpoint containing password/query sentinels emits only fixed PostgreSQL context plus safe code. Availability errors returned through the supervised repository are normalized before Worker/relay consumers see them. |
| RabbitMQ state and Outbox retry | A real refused endpoint containing password/query sentinels emits only fixed RabbitMQ context plus safe code; the exact normalized error reaches `OutboxRepository.releaseFailed`.                                                    |
| Process stderr                  | A real storage-maintenance failure does not echo the configured DSN or driver message. Runtime/Worker/relay state printers consume normalized producer values.                                                                        |
| Issuer boundary                 | The secret is environment-only, result serialization omits the token, unsupported input values are not echoed, and stdout remains the one explicit credential output documented for direct mode-`0600` file capture.                  |

## Failures and limitations

- The first restricted-sandbox focused run could not create Unix sockets or local failed connections
  and reported `EPERM` for 13 socket/network scenarios. The same 5-file/23-test gate passed outside
  that sandbox; this was an execution-environment restriction, not a product failure.
- The first manual maintenance command left `?` unquoted, so zsh treated the URL as a glob and never
  started the application. The quoted command above is the executed product check and passed its
  no-sentinel assertion.
- `rpc:grant` stdout is credential material by design. Shell tracing, a service manager that captures
  issuer stdout, or an operator copying it into logs remains an operator disclosure.
- JavaScript private fields and weak storage prevent ordinary enumeration, not a same-process
  debugger, malicious instrumentation, environment reads, memory dumps, core files, or swap access.
- Code-only diagnostics intentionally omit raw dependency text. There is no privileged secure-debug
  sink yet.
- Shell marker/path hostile inputs, HTTP request-rate limits, third-party custom logging, remote
  transport, and multi-user isolation remain outside M10.9.

## Conclusion

M10.9 passes the defined local L2 gate: the current Runtime RPC credential lifecycle and ordinary
operational diagnostics have executable sentinel evidence across serialization, Unix RPC errors,
PostgreSQL/RabbitMQ state, Outbox retry facts, and a real process stderr path. This is not a claim of
host-level secret confinement or repository release readiness.
