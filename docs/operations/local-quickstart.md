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
- `mcpConfigPath` — copy or reference this whole generic `mcpServers.iterminal` object in a client;
- `runtimeSocketPath` — local Unix RPC path;
- `database` — `managed-local-postgres` or `external-postgres`.

The default state root is `.iterminal/local`. Its credential directory and files are mode `0700`
and `0600` on POSIX. `mcp.json` contains a bearer grant and is credential material: do not print,
commit, upload, or share it. A fresh Console grant and 24-hour MCP grant are issued at each startup;
restart the stack to rotate an expired local grant. The Runtime verification secret and managed
database password are generated locally and retained across normal restarts.

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

## Deliberate boundary

This topology uses immediate dispatch in one Runtime. It does not start RabbitMQ, Outbox relay,
Execution Worker, Router, multi-owner placement, remote bind/TLS, or an OS sandbox. Use the explicit
component commands and their dedicated verification paths for those topologies. Loopback and file
permissions do not protect against hostile code running as the same OS user.
