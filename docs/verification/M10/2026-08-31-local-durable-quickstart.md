# M10.13 local durable quickstart verification

**Result: PASS at L2**

## Scope

This report verifies the one-command local composition of managed PostgreSQL, the existing durable
Runtime, loopback Human Console, and generated authenticated stdio MCP configuration. It also
verifies that terminal SIGINT does not kill the host-local Process Guardian before Runtime drain.

Baseline before this change: `617d6c1`. Environment: Darwin 25.5.0 arm64, Node.js 24.15.0, pnpm
10.33.2, Docker Engine 29.4.1, Docker Compose 5.1.3, `postgres:17-alpine`, real node-pty/zsh, official
`@modelcontextprotocol/client` 2.0.0. All databases, Compose projects, volumes, sockets, workspaces,
and state roots used by the scenario were isolated test fixtures and removed afterward.

## Automated gates

```sh
pnpm typecheck
pnpm lint
pnpm test:m10:local

ITERM_DATABASE_URL=postgresql://iterminal_test:<redacted>@127.0.0.1:55432/iterminal_test \
  pnpm test:m10:local

pnpm exec vitest run --maxWorkers=1 \
  packages/executor-pty/src/pty-process-guardian.test.ts
```

Results:

- credential-only gate: 1 passed; private directories/files were `0700`/`0600`, the database
  password was stable, grants/secrets were non-enumerable, and the MCP file contained no Runtime
  verification secret;
- real PostgreSQL gate: 2 passed; the official MCP client created one Session, completed a real zsh
  Execution, the Console bootstrap observed the same Session, the Unix socket disappeared on close,
  and PostgreSQL recorded `CLOSED`;
- Guardian gate: 2 passed; reclamation still covered delayed descendants and the Guardian was a
  distinct process-group leader that accepted renewal.

## Real one-command scenario

An isolated project/state/port tuple ran the actual entrypoint:

```sh
ITERM_LOCAL_STATE_DIR=<private-temp>/state \
ITERM_LOCAL_COMPOSE_PROJECT=<isolated-project> \
ITERM_LOCAL_POSTGRES_PORT=<isolated-loopback-port> \
ITERM_CONSOLE_PORT=0 \
pnpm local
```

Observed outcomes:

1. Console assets built and Compose created one named PostgreSQL volume and a healthy loopback
   container.
2. The command emitted one non-secret `iterminal.local.ready` object with exact Console, MCP config,
   and Runtime socket paths.
3. The official MCP SDK loaded that generated config, created one Session, completed
   `printf 'one-command-live-proof\n'` in real zsh, matched the output, and listed the Session.
4. A Console `/api/bootstrap` request with the required local header observed that exact Session.
5. Ctrl+C stopped Console/Runtime/PostgreSQL and exited 130; restart reused the named volume.
6. Direct PostgreSQL inspection after restart returned the exact Session as generation 1,
   `CLOSED`. A second Ctrl+C also stopped cleanly.
7. Every named test Compose project and volume was removed after the evidence was captured.

## Failed attempts and corrections

The first real Ctrl+C attempt preserved the database but reconciled the Session as `BROKEN` and
returned a shutdown error. Safe staged diagnostics reduced the failure to Runtime, then to
`RUNTIME_UNAVAILABLE: Host-local Process Guardian is unavailable`.

The Guardian was a child process but still shared the Runtime's terminal process group, so SIGINT
killed it before Runtime drain. `PtyProcessGuardian` now starts as a detached process-group leader
while retaining its explicit IPC channel. ADR-0045 and the process-group regression were updated
before the real scenario was repeated. The corrected run produced `CLOSED`, not `BROKEN`.

## Not proven

- A real browser render/input session in this quickstart run; the existing M5/M6/M10 browser
  reports remain the L3 Human path evidence.
- RabbitMQ, Outbox relay, Execution Worker, Router, multi-owner placement, failover, or production
  deployment from this single-Runtime immediate-dispatch topology.
- Clean-machine Docker/Node installation, Linux distribution matrix, Windows/ConPTY, Podman, or
  cross-platform packaging.
- Client-specific automatic config installation, online grant refresh/revocation, secrets-manager
  integration, multi-user isolation, remote bind/TLS, or hostile same-user containment.
- Whole-host/cgroup signal policy, VM fencing, long-duration quickstart dogfood, release packaging,
  SBOM, provenance, or repository-wide release L4.

## Conclusion

M10.13 closes the planned local one-command PostgreSQL + durable Runtime + Web bootstrap and emits a
copyable least-privilege MCP configuration without printing credentials. The result is a real local
L2 onboarding path, not a production or release-readiness claim.
