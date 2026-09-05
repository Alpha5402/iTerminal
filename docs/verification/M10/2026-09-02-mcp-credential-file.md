# Explicit MCP credential file verification

## Observed incident

On 2026-09-02 the installed Codex `iterminal` entry retained a static grant issued at
2026-08-31 22:58:59 +08 and expired at 2026-09-01 22:58:59 +08. A local metadata-only inspection
confirmed its signature against the existing Runtime key, matching audience and configured Actor,
and the presence of `execution.get`. The generated private local config held a different,
unexpired grant. No credential bytes were printed, saved in this report, or sent to another task.

The bridge reads static environment authorization once at startup. Tool discovery did not perform
a Runtime request. This explains why tools appeared installed while their RPC authorization failed.
During investigation the Runtime process and both Console/socket listeners were absent, while
PostgreSQL remained healthy. A read-only query then returned `ECONNREFUSED`, a separate availability
failure whose process-exit cause has not been established.

The user explicitly authorized starting a new Runtime. No existing PTY or game process was killed
by this repair. After startup, an independent official MCP client in file mode successfully called
`session_list`. The exact requested old Execution query returned `EXECUTION_NOT_FOUND`, not
`POLICY_DENIED`; it was not silently recreated. There was no terminal input or game command.

## Implementation

ADR-0063 adds opt-in `ITERM_MCP_CONFIG_FILE`. Each operation loads an already-issued local grant
from a bounded same-user private regular file, checks the fixed socket/Actor and declared Actor
capabilities, then submits one authenticated RPC request. No signing, expiry extension, fallback
credential search, broader Actor, server-verification bypass, or denied-operation retry exists.

The global Codex entry was updated through its MCP CLI, preserving the command, arguments, socket,
Actor fields, enabled state, and default tool selection. Only the credential source changed; no
bearer was put into command-line arguments. The already-running Codex MCP child still returned the
old authorization denial afterward, demonstrating that this first configuration change requires
the client's MCP restart. A separate fresh MCP child using the installed file configuration passed
authentication. Revalidation of the existing host child after user restart is still pending.

## Gates

Environment: macOS arm64, Node.js 24.15.0, pnpm 10.33.2, real zsh/node-pty/Unix RPC, official MCP
client/server SDK 2.0.0, and the existing local PostgreSQL-backed instance for read-only checks.

```sh
pnpm typecheck
pnpm exec vitest run apps/mcp/src/credential-file.test.ts \
  apps/mcp/src/mcp-stdio.test.ts packages/runtime-rpc/src/index.test.ts --maxWorkers=1
pnpm verify
```

Targeted result: 24 passed. New coverage includes same-process file replacement, expiry,
socket/Actor mismatch, malformed token, missing/insecure/symlink/oversize files, mutually exclusive
sources, no empty-provider fallback, opaque client serialization, real MCP repeated read-only
queries after rotation, and continued Runtime rejection of wrong signatures and missing operation
scope. Test grants use independent random test keys; fixtures are removed by the harness.

Full verification passed: formatting, lint, typecheck, 171 tests across 43 files, verification
document checks, and production build. Another 105 tests across 33 files were environment-gated
and skipped, not counted as passed. The existing Vite chunk-size warning remains non-fatal.
After verification the restarted Console still returned HTTP 200 at `http://127.0.0.1:4173/`.

## Boundary

L1 source/security checks and L2 real local MCP/Runtime/Shell integration. This is not successful
retrieval of the lost Execution, proof of the old process's death cause, an automatic renewal or
revocation protocol, nor confirmation that every existing Codex task has restarted its MCP child.
The Runtime's public authentication failure remains deliberately uniform; local file-expiry
diagnostics are not server-signature evidence.
