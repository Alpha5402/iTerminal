# M10.4 Human secret input and sensitive-output redaction verification — 2026-08-31

**Result: PASS at L3 (real local zsh/PTTY + PostgreSQL 17 + signed Runtime RPC + headless Chrome Human Console + official MCP SDK Agent observation).** The authenticated Human path delivers transient secret bytes through a metadata-only `SecretInputAction`, enables fail-closed redaction inside the PTY Executor before the write, and prevents submitted secret or raw output observed during the active sensitive period from entering the Runtime persistence and observation surfaces covered below.

This is a bounded Runtime guarantee. It is not OS memory, swap, core-dump, browser-devtools, remote/multi-user, or post-redaction taint protection.

## Environment

- macOS arm64 host, Node.js 26.4.0, pnpm 10.33.2.
- Real local `node-pty` zsh Session and mode-`0600` Unix Runtime socket.
- Disposable `postgres:17-alpine` database named `iterminal_test`; migration 016 adds the metadata-only sensitive-input state and active-period uniqueness constraint.
- Real headless Chrome Human Console plus an official MCP TypeScript SDK stdio Agent using separately scoped signed grants.

The PostgreSQL fixtures refuse to mutate a database whose name is not exactly `iterminal_test`. The tests use synthetic sentinels only; no external or user secret is written into source, reports, logs, or committed artifacts.

## Contract covered

- Only an authenticated Human with `secret.input` may begin or finish a sensitive input period; MCP exposes no corresponding tool.
- The period targets one exact Session generation and active Execution, composes with Input Policy/Guard/screen-version checks, and is versioned.
- `SecretInputAction`, sensitive state, Events, and idempotency material contain lifecycle metadata only—never secret bytes, hashes, lengths, masks, or previews.
- Acceptance and write-attempt metadata commit before one PTY write. An admitted idempotent replay returns the original metadata and never writes either supplied value again.
- Redaction starts synchronously inside the Executor before `pty.write`; every active-period PTY chunk is suppressed before Session/Execution rings and `onOutput`.
- The same sanitized stream feeds Event payload/search text, Artifact content, Virtual Screen, WebSocket, Console, and MCP reads.
- Ordinary Input and new Execute are blocked while active. Only the exact opening Human may send Control such as Ctrl+C; Control does not end redaction.
- Finish commits before redaction is disabled. Disconnect, timeout, or Execution exit does not auto-finish; generation loss leaves historical uncertainty rather than replaying secret bytes.

## Commands and results

### Application and Executor

```bash
pnpm exec vitest run --maxWorkers=1 \
  packages/executor-pty/src/sensitive-output-sanitizer.test.ts \
  packages/application/src/secret-input.test.ts
```

Two test files and five tests passed. The tests cover fixed-notice suppression across split ANSI chunks, irreversible discard of PTY barrier-prefix bytes buffered across the redaction boundary, metadata-only Action/Event shape, Human-only capability admission, idempotent no-rewrite, ordinary-Input/new-Execute denial, exact-Human Control, versioned finish, and visible output resumption after explicit finish.

### Real PostgreSQL 17 and zsh PTY

```bash
ITERM_DATABASE_URL=postgresql://iterminal:<redacted>@127.0.0.1:<ephemeral>/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
  apps/runtime-daemon/src/secret-input-durable.test.ts \
  packages/persistence-postgres/src/postgres-runtime-repository.test.ts
```

Two files and ten tests passed. Migration 001–016 applies from an empty database. The durable scenario opens a real zsh foreground interaction, submits one generated sentinel, verifies Agent Input denial and Human Ctrl+C while redaction remains active, then explicitly finishes. A PostgreSQL scan checks Action payload, Event payload/search text, Artifact content, Execution output, Screen projection, and sensitive state; the sentinel is absent everywhere.

### Authenticated RPC, Console, and real Browser Human-Agent path

```bash
pnpm exec vitest run --maxWorkers=1 \
  packages/runtime-rpc/src/index.test.ts \
  apps/console/src/server.test.ts

pnpm build:console
ITERM_DATABASE_URL=postgresql://iterminal:<redacted>@127.0.0.1:<ephemeral>/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 apps/console/src/browser-shared-path.test.ts \
  -t "keeps Browser Human secret input"
```

The five-file aggregate M10.4 command passed 25 tests, including the paired-prefix Human grant and same-origin/cookie Actor cases plus rejection of a mismatched Human identity before gateway dispatch. The selected Browser case passed one target test with three unrelated cases skipped: the password field starts the period, an official MCP Agent sees no secret tool and only the sanitized screen, Agent ordinary Input is rejected, the Browser Human sends Ctrl+C while redacted, explicitly ends the period, and later safe output becomes visible. The final database sentinel scan remains empty.

### Repository gate

```text
pnpm verify

format: passed
lint: passed
typecheck: passed
tests: 29 files passed, 31 skipped; 110 tests passed, 92 skipped
verification reports: 45 verified
production build: passed
```

The Vite build retains the existing warning that the Console JavaScript chunk is larger than 500 kB. It is not a build failure, and M10.4 does not claim bundle-size closure.

## Not proven

- The secret exists transiently in browser, HTTP/RPC request, JavaScript, Node.js, and PTY write memory. This work does not provide zeroization, mlock, swap protection, core-dump protection, or protection from hostile same-user process inspection.
- Browser developer tools, endpoint telemetry outside this repository, reverse proxies, accessibility tooling, extensions, keyloggers, and screen capture are not part of the verified boundary.
- Redaction starts only after explicit Human activation and ends only after explicit Human finish. It does not erase earlier output or taint-track a program that prints a remembered value later.
- The fixed notice hides active-period output length from Runtime output consumers, but external timing and CPU/process side channels are not analyzed.
- Cross-browser/platform behavior, remote or multi-user authorization, daemon-restart reconciliation UX, hostile timing fuzzing, long dogfood, and repository release L4 remain open.
