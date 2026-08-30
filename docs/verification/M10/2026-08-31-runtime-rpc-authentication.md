# M10.2 authenticated Runtime RPC grants verification — 2026-08-31

**Result: PASS at L2 (real local zsh/PTTY + mode-0600 Unix sockets + official MCP SDK bridge + PostgreSQL 17 Router path + RabbitMQ 4 Worker dispatch).** Runtime RPC now rejects missing, malformed, expired, wrong-operation, or Actor-mismatched bearer grants before gateway dispatch. One verified caller grant crosses a central Router socket and is independently verified by the owner Runtime; an Execution Worker completes queue-driven dispatch with a separate exact service grant containing only `execution.dispatch`.

## Environment

- macOS arm64 host, Node.js 24.15.0, pnpm 10.33.2.
- Disposable `postgres:17-alpine` database named exactly `iterminal_test`, bound to random loopback port `51838`.
- Disposable `rabbitmq:4-alpine`, bound to random loopback AMQP port `51934`.
- Real local `node-pty` zsh Sessions and separate mode-`0600` Unix sockets for direct Runtime, central Router, and owner Runtime.
- Official MCP TypeScript SDK client starts the real stdio bridge with an exact Agent grant.
- HMAC secrets and bearer grants were generated in memory by the tests and were not printed or written into this report.

The PostgreSQL Router test refuses to mutate a database not named exactly `iterminal_test`. The two containers used dedicated random ports and were removed after verification.

## Commands

```bash
pnpm exec vitest run \
  apps/rpc-grant/src/issuer.test.ts \
  packages/runtime-rpc/src/index.test.ts \
  apps/runtime-daemon/src/rpc-authentication.test.ts \
  apps/mcp/src/rpc-authentication.test.ts

ITERM_M10_RPC_DATABASE_URL=postgresql://postgres:<redacted>@127.0.0.1:51838/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
  apps/runtime-router/src/rpc-authentication.test.ts

ITERM_DATABASE_URL=postgresql://postgres:<redacted>@127.0.0.1:51838/iterminal_test \
ITERM_RABBITMQ_URL=amqp://iterminal:<redacted>@127.0.0.1:51934 \
  pnpm exec vitest run --maxWorkers=1 \
  apps/execution-worker/src/execution-worker.test.ts \
  -t 'exact least-privilege Worker service grant'
```

Focused results:

- issuer + Runtime RPC + direct daemon + authenticated MCP: 4 files / 18 tests passed;
- authenticated Router→owner: 1 file / 1 test passed;
- authenticated RabbitMQ Worker dispatch: 1 selected test passed, 5 unrelated tests skipped by the filter;
- pre-existing MCP bridge regression after adding the explicit test-only bypass: 5 files / 22 tests passed.

## Verified behavior

| Boundary                        | Evidence                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential schema               | Canonical base64url secret is at least 32 bytes; payload is bounded to 16 KiB; unknown fields/version/operations, duplicate or unsorted operations, invalid lifetime, encoding, signature, or audience fail closed.                         |
| Time and operation scope        | Missing, tampered, expired, and out-of-allowlist grants return the same generic `POLICY_DENIED` without invoking the gateway.                                                                                                               |
| Exact Actor binding             | An Agent token cannot submit a canonical Human Actor body. ID, type, principal, client, and the exact canonical capability list must all match before a real zsh command is admitted.                                                       |
| Console namespace scope         | A paired-prefix Human scope accepts only matching non-empty suffixes for `human_console_<suffix>` and `local-console:<suffix>`; a mismatched suffix is denied.                                                                              |
| Direct daemon                   | An unauthenticated Unix client is denied; an exact Agent grant creates one Session, executes and waits for a real zsh command, and closes the generation.                                                                                   |
| Official MCP bridge             | The real stdio main reads `ITERM_RPC_GRANT`; an official SDK client creates a Session and completes a real zsh execution whose request Actor exactly matches the token.                                                                     |
| Router proxy and owner re-check | One token is verified at the Router, forwarded only from verified request-local context, then accepted by the owner. Direct unauthenticated access to the owner socket is denied.                                                           |
| Worker service identity         | A distinct exact System service grant containing only `execution.dispatch` lets a real RabbitMQ wake-up complete one externally dispatched zsh Execution. The Agent admission token is separate and cannot be replaced by the Worker token. |
| Secure process configuration    | Runtime/Router mains require `ITERM_RPC_AUTH_SECRET`; Console/MCP/Worker mains require `ITERM_RPC_GRANT`. The unauthenticated compatibility path requires both `NODE_ENV=test` and explicit `ITERM_RPC_TEST_ALLOW_UNAUTHENTICATED=1`.       |
| Grant issuance                  | The repository issuer rejects unknown/duplicate operations and mixed exact/prefix fields, sorts the allowlist canonically, uses canonical type profiles, caps TTL at 30 days, and reads the secret only from the environment.               |

## Not proven

- Hostile code running with the same OS user's ability to read another process's environment, memory, or credential files. Runtime RPC grants are not an OS sandbox.
- Online revocation, key identifiers, asymmetric issuers, automatic rotation, or a remote multi-user trust domain.
- Process-crash isolation specifically under authenticated Router/owner credentials. The focused Router proof uses separate Unix sockets and full verification at both servers inside one Vitest process; earlier independent-process M9 chaos tests intentionally use the explicit test-only unauthenticated mode.
- Approval decisions, Approval expiry/use, Human-only secret input, sensitive-period recording redaction, or their audit UI.
- Full hostile origin/token/log/resource-exhaustion security matrix, clean-machine release, cross-platform release, or repository-wide L4.
