# M10.2 Runtime RPC authentication

Every production Runtime daemon and central Router requires an HMAC-SHA256 Runtime RPC verification secret. Every Console, MCP bridge, and Execution Worker requires a separately issued bearer grant. The same caller grant crosses a Router hop and is verified again by the owner Runtime; a Router does not exchange it for broader service authority.

This is a local single-OS-user trust domain. Unix sockets remain mode `0600`. The grant separates Console, Agent, and Worker authority but does not sandbox hostile code that can read the host user's process environment or credential files.

## Configuration

| Variable                               | Process                               | Meaning                                                                   |
| -------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| `ITERM_RPC_AUTH_SECRET`                | Runtime daemon, Router, grant issuer  | Canonical base64url encoding of at least 32 random bytes                  |
| `ITERM_RPC_AUTH_AUDIENCE`              | Runtime daemon, Router                | Exact audience; defaults to `iterminal-runtime-rpc`                       |
| `ITERM_RPC_GRANT`                      | Console, MCP bridge, Execution Worker | Already-issued scoped bearer grant                                        |
| `ITERM_RPC_TEST_ALLOW_UNAUTHENTICATED` | test subprocess only                  | Value `1` works only together with `NODE_ENV=test`; production rejects it |

All owner daemons behind one Router must use the same audience and verification secret as that Router. A missing server secret or client grant fails process startup. Empty, malformed, expired, wrong-audience, or bad-signature credentials fail closed and are never included in Runtime error details.

Generate and protect a local secret without placing it in command arguments:

```bash
mkdir -p .iterminal/credentials
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' \
  > .iterminal/credentials/runtime-rpc.secret
chmod 600 .iterminal/credentials/runtime-rpc.secret
export ITERM_RPC_AUTH_SECRET="$(< .iterminal/credentials/runtime-rpc.secret)"
```

`.iterminal/` is repository-ignored. Operators must keep the secret and issued grants outside logs, shell tracing, source control, Events, recordings, and verification artifacts.

## Issue least-privilege grants

The issuer reads the secret only from `ITERM_RPC_AUTH_SECRET` and writes one token to stdout. It rejects unknown or duplicate operations, mixed Actor scopes, malformed secrets, and TTLs longer than 30 days. Default TTL is one hour.

An MCP Agent uses an exact Actor scope. The bridge environment must exactly match the issued id, principal, and client:

```bash
pnpm --silent rpc:grant -- \
  --type agent \
  --client mcp-stdio \
  --id agent-local \
  --principal local-agent \
  --operations approval.get,approval.list,approval.request,control.send,events.query,execution.get,execution.start,execution.wait,input.send,interaction.get,screen.cells,screen.diff,screen.get,screen.region,screen.search,screen.wait,session.checkpoint.get,session.close,session.create,session.fork,session.get,session.list,terminal.resize,terminal.state.get \
  > .iterminal/credentials/mcp.grant
chmod 600 .iterminal/credentials/mcp.grant
```

Start the bridge with the matching Actor and grant:

```bash
ITERM_ACTOR_ID=agent-local \
ITERM_ACTOR_PRINCIPAL=local-agent \
ITERM_ACTOR_CLIENT=mcp-stdio \
ITERM_RPC_GRANT="$(< .iterminal/credentials/mcp.grant)" \
ITERM_RUNTIME_SOCKET=/absolute/path/to/runtime.sock \
pnpm mcp
```

The Human Console needs a paired-prefix scope because it creates an unpredictable cookie Actor. The two suffixes must be identical, so this grant cannot claim an arbitrary Human principal:

```bash
pnpm --silent rpc:grant -- \
  --type human \
  --client human-console-web \
  --scope paired-prefix \
  --id-prefix human_console_ \
  --principal-prefix local-console: \
  --operations approval.decide,approval.get,approval.list,control.send,events.query,execution.get,execution.start,execution.wait,input.send,interaction.get,interaction.guard.acquire,interaction.guard.release,interaction.guard.renew,interaction.policy.set,screen.cells,screen.diff,screen.get,screen.region,screen.search,screen.wait,session.checkpoint.get,session.close,session.create,session.fork,session.get,session.list,terminal.resize,terminal.state.get \
  > .iterminal/credentials/console.grant
```

The Execution Worker requires only dispatch authority. Its exact service Actor scope is an authenticated service identity; `execution.dispatch` has no request-body Actor to persist:

```bash
pnpm --silent rpc:grant -- \
  --type system \
  --client execution-worker \
  --id system-execution-worker \
  --principal local-execution-worker \
  --operations execution.dispatch \
  > .iterminal/credentials/worker.grant
```

## Enforcement order

For an authenticated server request:

1. parse the bounded request envelope and operation;
2. verify token encoding, signature, audience, known canonical operation list, issue time, expiry, and maximum lifetime;
3. require the requested operation in the token allowlist;
4. validate the operation input schema;
5. for Actor-bearing operations, compare the full Actor body against the exact or paired-prefix scope;
6. only then call the Runtime gateway and existing Application capability, Input Policy, Guard, freshness, idempotency, and fencing checks.

Authentication failures use one generic `POLICY_DENIED: Runtime RPC authorization failed` response. This avoids turning detailed validation errors into a token oracle. Invalid public request structure remains `INVALID_REQUEST` where it can be classified before credential verification.

## Rotation and limits

Grants are bearer credentials and remain usable until expiry. This version has no online revocation list or key identifier. Rotate by stopping admission, replacing the secret on the Router and all owner daemons, issuing replacement client grants, and restarting the affected processes. HMAC verifiers can also mint grants if compromised; asymmetric multi-issuer federation and remote/multi-user transport are outside this local M10.2 boundary.
