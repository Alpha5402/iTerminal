# Local durable quickstart

`pnpm local` is the supported one-command development path for one durable Runtime, the Human
Console, and a ready-to-use stdio MCP bridge configuration. It composes existing production-shaped
components; it does not implement a second Runtime.

## Prerequisites

- Node.js 22 or newer and pnpm 10;
- installed repository dependencies;
- macOS or Linux with zsh;
- Docker with Compose support, unless an external writable PostgreSQL primary is configured.

## Start

```sh
pnpm local
```

The command builds Console assets, starts and health-checks a loopback `postgres:17-alpine`
container, runs the PostgreSQL-backed Runtime with immediate owner-local dispatch, starts the
loopback Console, and writes a private MCP configuration. Read the final
`iterminal.local.ready` JSON line for:

- `consoleUrl` — open this exact `127.0.0.1` authority; alternate Host aliases are rejected;
- `mcpConfigPath` — private on-disk handoff used internally by the local stack;
- `runtimeSocketPath` — local Unix RPC path;
- `database` — `managed-local-postgres` or `external-postgres`.

In the Console, use **Connect MCP** in the right inspector to copy the complete `mcpServers` JSON
directly. The UI does not expose the private config path.

The default state root is `.iterminal/local`. Credential directories/files are mode `0700`/`0600`
on POSIX. `mcp.json` is a same-host bootstrap that references `credentials/mcp-local.json` through
`ITERM_MCP_CONFIG_FILE`; the bearer grant stays in that private credential file. The copied JSON
contains machine-local paths, so it is not a portable remote connection profile.

The supervisor renews the same Actor and operation scope before expiry (five minutes early for
normal 24-hour grants, 20% early for short TTLs) and atomically replaces the private files. Existing
Console/MCP processes read the current grant per request; renewal does not restart the Runtime or
PTY. The signing secret and managed database password remain stable across normal restarts.

### Renewal failures and legacy inline grants

Keep the supervisor running. Renewal failures use bounded retry backoff; expired grants reject
requests until valid credentials are installed. `expired` and `stopped` renewal diagnostics include
only expiry metadata, never token values. Wall-clock deadlines are rechecked at most every 30
seconds; Runtime signature/expiry validation remains authoritative. Stopping the supervisor is not
an invitation to recreate or replay an uncertain Action.

An older MCP profile containing `ITERM_RPC_GRANT` is still static. Replace it with the current
stack-generated bootstrap and restart that MCP bridge once. Do not set both inline and file
credentials. The private file must be a same-user regular file and retain the configured socket and
Actor identity. The bridge neither executes JSON commands nor receives the signing key. Missing,
malformed, insecure, mismatched or expired files produce bounded errors; no denied or uncertain
write is automatically retried.

### Distinct local Agents

Set `ITERM_AGENT_NAME=alpha` and optionally `ITERM_ADDITIONAL_AGENT_NAMES=beta,gamma` before
`pnpm local`. Names are 1–48 ASCII letters, digits, underscores or hyphens, beginning with a letter
or digit. Named profiles are `mcp-alpha.json`, `mcp-beta.json`, etc.; each references its own private
credential file. The default `local` profile retains `agent-local`. A configured name binds a stable
Actor across renewal and MCP bridge restart. Different identities do not provide Session ACLs or
strong isolation between processes running as the same OS user; [the ACL proposal](../adr/0081-opt-in-session-authorization-design.md)
is design only.

### Shared JSONL CLI

`pnpm cli` defaults to an authenticated daemon client. Configure `ITERM_RUNTIME_SOCKET`, an
operator-issued `ITERM_RPC_GRANT`, and matching `ITERM_ACTOR_ID`, `ITERM_ACTOR_PRINCIPAL`, and
`ITERM_ACTOR_CLIENT` in its environment. The current CLI supports inline grants only; it does not
read the MCP credential file or automatically renew its inline grant. Never paste a grant into a
committed script or shell history. `pnpm cli -- --standalone` explicitly selects the isolated
in-memory development runtime.

Send one JSON object per line, for example `{"requestId":"list-1","op":"list"}`. Responses include
the same request ID. `wait` takes `executionId` and bounded `waitMs`; it does not block a subsequent
`control` request. EOF cancels this client's waits and leaves shared Sessions alive. Only an explicit
`close` request closes a Session. Missing service, invalid grants and incompatible protocol versions
produce errors instead of silently creating another Runtime.

Verify with a read-only `session_list` or `execution_get`. `ECONNREFUSED` means the configured
Runtime endpoint is not listening, independently of grant validity. After Runtime loss, an old
Execution may return `EXECUTION_NOT_FOUND`; a fresh authenticated connection does not restore it.

Press Ctrl+C once to close the Console, drain the Runtime, persist live Sessions as `CLOSED`, close
the detached Process Guardian, and stop PostgreSQL. Exit status 130 is the normal shell convention
for an intentional SIGINT. The named database volume is preserved.

If the wrapper crashed or was interrupted before the ready line and left the managed container
running:

```sh
pnpm local:stop
```

Do not delete only `.iterminal/local` while retaining the default database volume: the regenerated
password would no longer match the initialized database. Treat state-directory and volume reset as
one deliberate destructive operation.

## Use an external PostgreSQL primary

Set exactly one database form before starting:

```sh
ITERM_DATABASE_URL=postgresql://... pnpm local
# or an ordered primary-only list
ITERM_DATABASE_URLS=postgresql://...,postgresql://... pnpm local
```

The supervisor neither starts nor stops Docker in this mode. Existing endpoint validation and
primary-only fail-closed semantics remain in force.

## Options

| Variable                         | Default            | Purpose                                            |
| -------------------------------- | ------------------ | -------------------------------------------------- |
| `ITERM_LOCAL_STATE_DIR`          | `.iterminal/local` | Private socket, grant, and local credentials       |
| `ITERM_LOCAL_POSTGRES_PORT`      | `55432`            | Managed loopback PostgreSQL host port              |
| `ITERM_LOCAL_COMPOSE_PROJECT`    | `iterminal-local`  | Isolated Compose project/volume namespace          |
| `ITERM_CONSOLE_PORT`             | `4173`             | Loopback Console port; `0` selects a free one      |
| `ITERM_AGENT_EXECUTE_APPROVAL`   | `optional`         | `optional` or Human `required` for Agent Execute   |
| `ITERM_LOCAL_SKIP_CONSOLE_BUILD` | unset              | Set to `1` only when `dist/console-web` is current |

## Troubleshooting

### Offline is not BROKEN

A lost browser HTTP/WebSocket connection only changes the Console connection indicator to offline.
The Runtime keeps its PTY and database heartbeat independently. Restoring that connection resumes
observation of the same live generation; it does not replay submitted commands.

Losing Runtime/PostgreSQL authority is different. The current local stack also uses database-time
owner leases (15 seconds by default). A database outage, prolonged scheduling pause, or host sleep
can invalidate those leases. The Runtime then closes old PTYs and settles ambiguous work as
`BROKEN/UNKNOWN` before serving new Sessions. A checkpoint rebuild starts a new Shell; it cannot
resume a game client or other process. Simply restoring Wi-Fi cannot resurrect the old process.

The historical recovery reason `PostgreSQL outage invalidated Runtime owner` is generic: it can
also follow an expired owner heartbeat, so it is not by itself proof the PostgreSQL server stopped.
Correlate the fault time with database and host sleep/wake logs. Sleep-preserving single-host
terminal ownership is not implemented; do not disable fencing or automatically replay old commands
to disguise that boundary.

### Copying long commands

Updated Runtime snapshots carry soft-wrap metadata. Updated Console copying joins visually wrapped
rows while preserving actual newlines and empty lines. Both components must be updated; rebuild
assets, explicitly restart the Runtime when existing work can stop, then reload the page. Old
already-corrupted history entries are not repaired automatically. Copy from a clean source or edit
the unintended newlines before submitting again.

## Deployment boundary

This topology uses immediate dispatch in one Runtime. It does not start RabbitMQ, Outbox relay,
Execution Worker, Router, multi-owner placement, remote bind/TLS, or an OS sandbox. Use the explicit
component commands and their dedicated verification paths for those topologies. Loopback and file
permissions do not protect against hostile code running as the same OS user.
