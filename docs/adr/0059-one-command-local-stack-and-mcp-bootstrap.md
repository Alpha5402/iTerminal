# ADR-0059: One-command local stack and MCP bootstrap

- Status: Accepted for M10.13
- Date: 2026-08-31
- Refines: ADR-0007, ADR-0024, ADR-0045, ADR-0048, ADR-0054, ADR-0055

## Context

The durable local path is implemented but requires operators to separately start PostgreSQL, build
Console assets, create an RPC secret, issue two grants, start the Runtime, start the Console, and
assemble an MCP client configuration. That sequence is useful as explicit protocol documentation,
but it is not the planned one-command local onboarding path and is easy to misconfigure.

A quickstart must not create a second Runtime implementation, weaken authentication, expose the
Console remotely, print bearer tokens, or imply that a single-process development topology proves
the RabbitMQ/multi-owner production path.

## Decision

### Topology

`pnpm local` starts one development topology:

1. build the existing Console static assets;
2. start/health-check `postgres:17-alpine` through the checked-in Compose file when no external
   database target is configured;
3. start the existing PostgreSQL-backed Runtime daemon with immediate owner-local dispatch and
   required Runtime RPC authentication;
4. wait for durable Runtime readiness before starting the existing loopback Human Console;
5. write one ready-to-use stdio MCP configuration for the existing bridge.

The Node supervisor owns only process composition and shutdown. Runtime/Application state,
PostgreSQL migrations, RPC authorization, Console Host/Origin checks, and MCP tools remain in their
existing packages. RabbitMQ, Outbox relay, Execution Worker, Router, and multi-owner placement are
not part of this quickstart.

### Local PostgreSQL

The managed default binds PostgreSQL only to `127.0.0.1:55432`, uses database/user `iterminal`, and
stores data in a named Docker volume. The password is generated once and retained in the private
state directory so restarting against the same volume does not silently rotate the database
credential. Ctrl+C/SIGTERM stops the Console, drains/closes the Runtime, then stops the managed
PostgreSQL container; the named volume is preserved. A crash can leave the container running, and a
subsequent invocation reuses it.

If `ITERM_DATABASE_URL` or `ITERM_DATABASE_URLS` is supplied, the supervisor uses that target and
does not start or stop Docker. Configuring both remains invalid through the existing endpoint parser.

### Credentials and generated configuration

The default state root is `.iterminal/local`, already excluded from Git. Directories are mode `0700`
and secret/config files mode `0600` on supported POSIX platforms.

- one canonical 32-byte base64url Runtime verification secret is generated once and reused;
- a fresh 24-hour paired-prefix Human Console grant and exact MCP Agent grant are issued on each
  startup;
- grants and the secret are never passed as command-line arguments or printed to stdout/stderr;
- `mcp.json` contains the absolute bridge command plus exact Actor environment and bearer grant, so
  the whole file is credential material and remains mode `0600`;
- startup output prints only Console URL, socket path, MCP configuration path, database ownership,
  and lifecycle state.

The generated config uses the repository's installed `tsx` executable and existing MCP entrypoint.
It is a generic `mcpServers.iterminal` object suitable for copying into clients that accept that
shape. Client-specific installation remains explicit and must not upload the credential file.

### Lifecycle and failure

Startup is ordered and fail-closed. Console admission begins only after PostgreSQL migrations,
owner registration, reconciliation, RPC listener setup, and Runtime readiness. If a later stage
fails, already-started application components close in reverse order; a managed database is stopped
after application cleanup.

Shutdown closes the Console first, then performs the existing bounded Runtime drain/Session close,
then stops managed PostgreSQL. No signal path replays an Action or treats process exit as execution
success. The first SIGINT/SIGTERM owns one idempotent shutdown promise; duplicate wrapper signals do
not restore default termination while drain is in flight. The host-local Guardian remains on its
detached process group until Runtime Session close unregisters Shells and deliberately closes it.

## Consequences

- A developer with Node/pnpm/Docker and installed dependencies can reach the durable local Web + MCP
  path with one command and without manually handling tokens.
- The quickstart state directory becomes sensitive local material and must be protected, rotated,
  and deleted deliberately when no longer needed.
- Immediate dispatch keeps onboarding small but does not exercise Queue/Worker crash semantics.
- Building Console assets on each default startup favors correctness over startup speed; an explicit
  skip-build option is allowed only when the expected artifact already exists.

## Rejected alternatives

- **Duplicate Runtime logic in the wrapper:** would create a second state-transition owner.
- **Disable RPC auth on loopback:** ambient same-user clients would bypass the M10 grant boundary.
- **Print grants for copy/paste:** terminal history and collected logs are ordinary disclosure
  channels.
- **Put grants in committed MCP config:** violates credential and repository hygiene.
- **Run Shell/PTTY inside the PostgreSQL Compose service:** conflates storage with live owner
  authority and makes host workspace semantics misleading.
- **Start RabbitMQ and Worker in the default quickstart:** increases onboarding surface without being
  required for the one-owner immediate-dispatch path.
- **Delete the database volume on shutdown:** a quickstart restart must preserve durable history.

## Not covered

- Production deployment, remote bind/TLS, multi-user isolation, secrets managers, online grant
  rotation/revocation, or a secure client-config installer.
- Docker Desktop installation/repair, rootless daemon differences, Podman, Windows, Linux service
  managers, launchd/systemd, or clean-machine platform proof.
- RabbitMQ/Worker/Router orchestration, multi-owner placement, high availability, backup/restore,
  external volume quotas, or monitoring delivery.
