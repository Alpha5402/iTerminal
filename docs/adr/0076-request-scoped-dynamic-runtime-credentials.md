# ADR-0076: Request-scoped dynamic Runtime credentials

- Status: Accepted
- Date: 2026-09-05
- Refines: ADR-0048, ADR-0055, ADR-0056, ADR-0063

## Context

ADR-0063 lets the MCP bridge read a private file before each Runtime RPC attempt, while the Human
Console still freezes one inline grant at process start. Long-lived Console and MCP processes need
operator-issued replacement grants without restarting the bridge, Console, Runtime, Session, or
PTY. A file replacement must not become a way to change the caller identity or widen its operation
scope, and a temporarily unreadable replacement must not silently reuse an older credential.

The browser's cookie-derived Human Actor and the Console server's transport grant are separate
authorities. A server-side credential source may authenticate the Console transport; it must never
replace the browser Actor, be returned by bootstrap, or become browser-readable configuration.

## Decision

The Runtime RPC package owns one reusable private JSON file reader. The path must be absolute. Each
read opens the current pathname without following a final symlink, accepts only a bounded regular
file owned by the current user with no group or other permission bits, reads at most 64 KiB, and
closes the descriptor. It retains no credential bytes after returning and never caches a previous
grant.

Opening or reading the selected path may fail during an operator's replacement. Such source
availability failures produce a retryable `RUNTIME_UNAVAILABLE` authentication-source result with
a fixed message. An insecure file, invalid JSON, invalid grant declaration, expired grant, socket
mismatch, Actor mismatch, or scope mismatch produces `POLICY_DENIED`. Neither class includes the
path, parser error, file contents, or token. There is no fallback from file mode to an inline or
previous token.

The Console adds explicit `ITERM_CONSOLE_CREDENTIAL_FILE` file mode. It is mutually exclusive with
`ITERM_RPC_GRANT`; inline grants remain the compatibility path. The Console file has its own strict
server-side envelope containing only the exact Runtime socket and grant. It does not reuse the MCP
`mcpServers` envelope. Its declared grant Actor must remain the fixed Console paired-prefix Human
scope: `human-console-web`, `human_console_`, `local-console:`, and the canonical Human capability
profile. File data cannot override the cookie-derived browser Actor.

The MCP provider retains its existing `ITERM_MCP_CONFIG_FILE` envelope and exact configured Agent
binding. Both providers parse the canonical declared Runtime grant shape. On the first valid,
unexpired read, a provider pins the grant audience and canonical operation list; later replacement
grants must preserve both. Grant id, issuance time, expiry, and signature may change. Runtime-side
signature, audience, operation, and Actor authorization remain authoritative; local declaration
inspection is only a fail-closed source and binding check.

`UnixRuntimeClient` resolves an authorization provider exactly once before opening each RPC request
connection. That credential is immutable for the in-flight request. The next RPC request reads the
file again. The client does not retry mutations after an authentication or transport failure.

## Consequences

- Operators can replace Console and MCP grants without restarting either client process.
- Credential replacement does not rebuild a Session, change generation, replace the Shell, or
  alter PTY identity.
- A failed replacement is visible as authentication-source unavailability and cannot be hidden by
  stale cached authorization.
- Automatic issuance and renewal remain supervisor work; this decision only defines safe dynamic
  consumption.
- Same-user hostile code remains outside this local file-delegation boundary.
