# ADR-0007: Runtime daemon and stateless MCP stdio bridge

- Status: Accepted for M4
- Date: 2026-08-30

## Context

An MCP stdio server is normally launched and owned by one Client process. If that process also owns the persistent PTY, restarting the Client destroys the live Shell, Event cursor, and every other Actor's shared state. That lifecycle contradicts the Session-centric contract.

The transport must also never gain a second PTY write path. MCP tools need to invoke the same Application Service as the CLI and future Human Console, while preserving uncertainty when a cross-process response is lost.

## Decision

The local Runtime runs as a separate daemon and owns `RuntimeService`, Session Executors, PTYs, and Shells. The M4 MCP process is a stateless stdio bridge:

```text
MCP Client <-> stdio MCP bridge <-> 0600 Unix socket <-> Runtime daemon -> Application Service -> PTY
```

- The daemon listens on one explicit absolute Unix socket path and changes the socket mode to `0600`.
- Existing non-socket paths are never replaced. A live socket is never unlinked; only a stale refused socket may be removed.
- RPC inputs are bounded and schema-validated. Each request has a correlation ID and one response.
- Read failures return retryable `RUNTIME_UNAVAILABLE`.
- If a mutating RPC loses its response, the bridge returns `DELIVERY_UNKNOWN`; it must not auto-replay Execute/Input/Control.
- MCP Actor identity is fixed by the bridge process configuration, not supplied in each tool call.
- MCP stdout contains protocol frames only. Human-readable lifecycle messages use stderr.
- MCP Client restart creates a new bridge connection to the same daemon; it does not create a new Runtime or PTY.

## Consequences

- Human Console can later reuse the daemon/Application boundary instead of bypassing it.
- The daemon is now the live failure boundary. If it dies, its in-memory M4 Sessions are lost; PostgreSQL recovery still marks that truth BROKEN/UNKNOWN and is not yet wired into this daemon.
- Unix file permissions provide local process isolation, not user authentication, capability policy, or a sandbox.
- M4 RPC uses one connection per request for a simple uncertainty boundary. Connection pooling and backpressure remain later work.
- The M4 daemon still uses `MemoryRuntimeStore`; its Event retention is not the M3 PostgreSQL observation implementation.
