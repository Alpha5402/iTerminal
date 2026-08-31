# M10.11 hostile input and local ingress resource verification

**Result: PASS at L2 for bounded Shell control/barrier input, non-reflecting canonical path failures,
Console HTTP request rates, and Runtime RPC active/idle connection resources.**

Date: 2026-08-31

Platform: macOS arm64, Node.js 24.15.0, pnpm 10.33.2, real local zsh/node-pty, real mode-`0600`
Unix sockets, and real loopback HTTP/WebSocket clients

## Scope

- Make the 1 MiB Shell control limit cumulative across NUL-separated fields, not only the current
  decoder tail.
- Reject non-safe Shell PID and out-of-range exit-status control facts.
- Bound retained PTY barrier-looking text while preserving unknown/forged text as ordinary output.
- Prevent invalid workspace paths and raw filesystem errors from being copied into Runtime/Console
  error serialization.
- Add bounded-cardinality, process-local Console fixed-window limits for total and known-Actor API
  requests, with one shared anonymous bucket and explicit retry metadata.
- Bound active Runtime RPC sockets and destroy incomplete request frames before gateway dispatch.
- Re-audit the existing body, response, Actor, stream, WebSocket message/backbuffer, observation,
  Artifact, Event, and durable Action bounds without turning them into a whole-database claim.

## Commands and results

```sh
pnpm test:m10:hostile
```

Result: 5 files and 32 tests passed. The focused gate used a real zsh PTY for malicious barrier-like
output, real Unix sockets for active/idle RPC admission, real loopback HTTP/WebSocket requests for
rate and existing ingress limits, plus deterministic control-frame and path-error probes.

```sh
pnpm typecheck && pnpm lint
```

Result: TypeScript and ESLint passed after the production changes.

```sh
pnpm verify
```

Result: PASS. Prettier, ESLint, TypeScript, 35 test files / 130 tests, all 51 milestone reports, and
the production build passed. Another 32 test files / 99 tests remained explicitly skipped by their
declared environment gates. Vite retained the existing advisory for the 547.15 kB minified Console
chunk; it did not fail the build.

## Verified behavior

| Boundary                      | Evidence                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Control frame memory          | A frame that remains individually below 1 MiB in its current tail but exceeds 1 MiB after prior separated fields is rejected by cumulative accounting.                                                                                                       |
| Control facts                 | PID outside the safe-integer range and exit status below 0 or above 255 are fatal protocol errors; closed event/field counts and environment limits remain green.                                                                                            |
| PTY barrier                   | Real zsh emits an unterminated prefix plus 128 KiB and a complete forged token. Execution reaches its real barrier, hostile bytes remain observable, and neither forged form completes it early.                                                             |
| Canonical path diagnostics    | A unique nonexistent-workspace sentinel and `ENOENT` are absent from direct Runtime error serialization and the real Console response; only `pathKind=workspace_root` remains.                                                                               |
| Console Actor rate            | A known Actor receives two allowed requests then retryable `429 RATE_LIMITED`; the response has bounded Actor scope, a millisecond delay, and `Retry-After`.                                                                                                 |
| Console global/anonymous rate | A hostile unknown Cookie cannot create a rate bucket; it shares anonymous state. After four admitted requests, the next request is rejected by the global window before RuntimeGateway/Actor allocation. Advancing the controlled clock resets both windows. |
| RPC active sockets            | With a one-connection test limit, a second idle Unix client is destroyed without gateway dispatch.                                                                                                                                                           |
| RPC slow frame                | The admitted idle socket is destroyed after the configured 100 ms framing timeout; its capacity is released and a normal `session.list` request succeeds afterward.                                                                                          |
| Existing ingress bounds       | Exact Host/Origin/Fetch Metadata/header, 1 MiB HTTP body, Actor/stream cardinality, 16 KiB WS message, 1 MiB pending send, 1 MiB RPC request, and 16 MiB RPC response tests remain green.                                                                    |

## Failed attempts and corrections

- The first formatter pass rejected a JavaScript `\0` immediately followed by a digit as an octal
  escape. The fixture now uses explicit `\x00`; no production behavior was involved.
- The existing default full suite could starve the real Guardian watchdog under cross-file process
  pressure. M10.10 already made default `pnpm test` single-worker without weakening Guardian timing
  or assertions; M10.11 keeps that deterministic integration policy.

## Not proven

- Remote bind, reverse proxy/TLS, multi-user authentication, distributed rate limits, cgroup/ulimit
  enforcement, or a hostile same-user process that bypasses the Console and mode-`0600` socket.
- Arbitrary terminal escape-sequence sanitization, Shell command safety classification, same-user
  symlink/mount races after validation, or filesystem containment after the Shell starts.
- Exact protection when the Runtime/Guardian process, kernel scheduler, host, or filesystem is
  compromised.
- Long-duration hostile traffic/slowloris soak, cross-platform PTY/parser behavior, or browser
  compatibility beyond existing local Chrome evidence.
- Normalized Action/Approval/Outbox/Inbox retention, Artifact export/legal hold, recording lifecycle,
  whole-database disk limit/alerts, clean-machine installation, or repository release readiness.

## Conclusion

M10.11 closes the planned local hostile-input/resource matrix at L2. Shell control facts, PTY
barrier-like bytes, public path failures, Console request bursts, and idle Runtime RPC sockets now
have explicit executable bounds. These are local runtime safety controls, not an OS sandbox or
distributed production quota.
