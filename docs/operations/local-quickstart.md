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

The default state root is `.iterminal/local`. Its credential directory and files are mode `0700`
and `0600` on POSIX. `mcp.json` contains a bearer grant and is credential material: do not print,
commit, upload, or share it. A fresh Console grant and 24-hour MCP grant are issued at each startup;
restart the stack to rotate an expired local grant. The Runtime verification secret and managed
database password are generated locally and retained across normal restarts.

### Avoid stale copied MCP grants

MCP tool discovery only proves the stdio bridge started; it does not prove Runtime authorization.
A client configured with a copied `ITERM_RPC_GRANT` keeps that value until its MCP process is
reconfigured and restarted. Restarting only the local stack does not update the client's copy.

For a same-host client, an explicit alternative is to replace **only** `ITERM_RPC_GRANT` in its MCP
environment with `ITERM_MCP_CONFIG_FILE`, set to the absolute path of this stack's private
`.iterminal/local/mcp.json`. Keep the same command, arguments, Actor fields, and Runtime socket.
Do not set both credential variables. The file must be a same-user private regular file (`0600`),
and its socket/Actor must match the client configuration. The bridge never executes commands from
that JSON file or reads the Runtime signing key.

Restart the client's iTerminal MCP process once after this configuration change. In Codex, use
Settings → MCP servers → iterminal → Restart. Subsequent operator replacement of the file is read
on the next RPC request, without restarting the PTY. This **does not renew grants**: expiry still
requires a valid operator-issued replacement. No denied or uncertain operation is automatically
retried. Missing/malformed/insecure files and declared-expired grants produce bounded local-source
diagnostics; Runtime signature/audience/operation failures remain uniform `POLICY_DENIED` errors.

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
