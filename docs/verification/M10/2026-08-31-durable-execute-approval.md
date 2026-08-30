# M10.3 durable Agent Execute Approval verification — 2026-08-31

## Claim

M10.3b is verified at L3 for the defined local trusted-user path. An Agent can request review of one exact future Execute, an authenticated Human can approve or deny it, and PostgreSQL consumes an approved proposal at most once in the same transaction that admits the Action/Execution/Outbox work. A real headless Chrome Human Console approved a proposal created by an official MCP SDK stdio Agent, which then executed the exact command in their shared PostgreSQL-backed zsh Session.

This is not a complete operation-wide Approval matrix, remote/multi-user authorization, command-risk classifier, secret channel, release gate, or autonomous-model claim.

## Contract covered

- Runtime policy is explicitly `optional` or `required`; only new Agent `execution.start` is in this slice.
- Proposal identity binds Session ID/generation, canonical Agent identity and capabilities, command, and Action idempotency key.
- Request idempotency returns the original Approval for the same proposal and rejects changed reuse.
- Lifecycle is versioned `PENDING -> APPROVED | DENIED | EXPIRED`, with `APPROVED -> CONSUMED` only.
- Only a Human with `approval.decide` decides; MCP exposes request/get/list to its fixed Agent and never decide.
- TTL is 30 seconds–30 minutes, defaults to five minutes, and uses PostgreSQL time in durable mode.
- Exact admitted Action replay succeeds after consumption; another Action cannot reuse the Approval.
- Approval Events contain bounded identifiers/reasons/status and never duplicate the command.

## Executed evidence

### Application state machine and durable boundary

```text
pnpm typecheck
pnpm lint
pnpm exec vitest run packages/application/src/approval.test.ts \
  packages/application/src/runtime-durability.test.ts \
  packages/application/src/runtime-service.test.ts

3 test files passed; 14 tests passed.
```

The Application tests use a real zsh PTY for the accepted path and cover required-policy rejection, pending/denied/changed proposal rejection, Human-only decision, decision idempotency/versioning, lazy expiry, Agent read isolation, single consumption, exact Action replay, and command-free Approval Event payloads.

### Real PostgreSQL 17 atomicity

An isolated `postgres:17-alpine` container with database `iterminal_test` was used; credentials and the ephemeral host port are intentionally omitted.

```text
ITERM_DATABASE_URL=postgresql://postgres:<redacted>@127.0.0.1:<ephemeral>/iterminal_test \
  pnpm exec vitest run packages/persistence-postgres/src/postgres-runtime-repository.test.ts

1 test file passed; 9 tests passed.
```

The Approval case first injects `before_commit`. After rollback the Session is still `READY`, Action count is zero, and the Approval remains `APPROVED` version 2. Retrying commits one Action and changes the same Approval to `CONSUMED` version 3 with the admitted Action ID. Exact Action replay returns that Action after consumption; a different Action receives `APPROVAL_REQUIRED`. The persisted Action payload contains the command and Approval ID, while `approval.*` Event payloads do not contain the command.

### Durable daemon and Runtime RPC

```text
ITERM_DATABASE_URL=postgresql://postgres:<redacted>@127.0.0.1:<ephemeral>/iterminal_test \
  pnpm exec vitest run apps/runtime-daemon/src/approval-durable.test.ts

1 test file passed; 1 test passed.
```

A durable daemon runs with `agentExecuteApproval: required`. Unapproved and changed Agent Execute calls fail before admission. A Human approves the exact proposal over Runtime RPC; the Agent executes it through the same RPC gateway, observes real PTY output and exit code 0, then reads `CONSUMED`. Replaying the original Action returns the same Action and Execution IDs. PostgreSQL contains exactly requested, approved, and consumed Approval Events with no command content.

The existing two-owner central Router scenario was also run with Approval request, Human decision, exact Execute, and consumed read routed to the owning daemon:

```text
ITERM_DATABASE_URL=postgresql://postgres:<redacted>@127.0.0.1:<ephemeral>/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 apps/runtime-router/src/runtime-router.test.ts \
  -t "places new Sessions and routes exact operations across two live owners"

1 test passed; 3 tests skipped by the filter.
```

### RPC, MCP, Console, and real Browser Human-Agent path

```text
pnpm exec vitest run apps/mcp/src/mcp-stdio.test.ts \
  apps/console/src/server.test.ts \
  packages/runtime-rpc/src/index.test.ts

3 test files passed; 18 tests passed.

pnpm build:console
ITERM_DATABASE_URL=postgresql://postgres:<redacted>@127.0.0.1:<ephemeral>/iterminal_test \
  pnpm exec vitest run apps/console/src/browser-shared-path.test.ts \
  -t "shares cwd, env, Python REPL, Guard, screen, and attributed timeline across transports"

1 test passed; 2 tests skipped by the filter.
```

The official MCP SDK client discovers `approval_request`, `approval_get`, and `approval_list`. In the browser path it creates a proposal, the real Chrome Human Console renders the exact command and clicks `Approve once`, the MCP Agent observes `APPROVED`, executes with the bound `approvalId`, and the browser converges to `CONSUMED`. The remainder of the shared cwd/environment/Python REPL/Guard/screen/attributed Timeline scenario still passes.

Finally, a second empty PostgreSQL 17 container applied migrations 001–015 from scratch and ran the atomic repository, required-policy daemon/RPC, two-owner Router, and real Chrome+MCP Approval cases sequentially: four test files and four selected tests passed, with 13 unrelated tests skipped by the filter. This verifies that the final migration, including its 30-second–30-minute database constraint, does not depend on the earlier test database state.

### Repository gate

```text
pnpm verify

format: passed
lint: passed
typecheck: passed
tests: 27 files passed, 30 skipped; 103 tests passed, 90 skipped
verification reports: 44 verified
production build: passed
```

The Vite build retains the pre-existing warning that the Console JavaScript chunk is larger than 500 kB; it is not a build failure and this slice does not claim bundle-size closure.

## Remaining limits

- Approval covers Agent top-level Execute only. Input, Control, Resize, Fork, Human Execute, Scheduler, and System policy have no new Approval requirement.
- `optional` is the default for compatibility; operators must set `ITERM_AGENT_EXECUTE_APPROVAL=required` consistently on every Runtime owner for mandatory Agent review.
- The command remains sensitive durable data in the Approval and Action rows. Secret-channel input, recording redaction, retention/export policy, and audit sampling remain M10 work.
- Local HMAC grants authenticate the same-OS-user RPC boundary but do not provide remote/multi-user isolation, peer credentials, online revocation, or an OS sandbox.
- The real Browser proof uses one local Chrome build and macOS. Cross-browser/platform matrices, long dogfood, clean-machine packaging, and repository release L4 remain open.
