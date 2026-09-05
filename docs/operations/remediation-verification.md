# Required remediation verification

Ordinary `pnpm verify` retains optional external-service suites. A successful ordinary run therefore
does not prove all PostgreSQL, browser, RabbitMQ or platform scenarios ran.

`pnpm verify:integration` and `pnpm verify:shared-path` explicitly require an isolated PostgreSQL
`iterminal_test` database and a working local PTY. The shared-path gate also requires Chrome at
`ITERM_BROWSER_EXECUTABLE` (default macOS Chrome) and builds Console assets before testing.
The scripts reject the user's local-stack port 55432. They inspect Vitest JSON results and fail if
any required file is absent, empty, failed, skipped or todo. Required file lists are explicit in
`scripts/verify-integration.mjs`.

Provision a separate PostgreSQL container on loopback port 55433 (or another dedicated port), create
only `iterminal_test`, and inject its connection URL as `ITERM_DATABASE_URL` without printing it.
Tests truncate their fixture tables and must run serially against that database. For outage tests,
`ITERM_TEST_POSTGRES_CONTAINER` must name that same dedicated container; never a user service.
This run used `iterminal-d01-postgres` on 55433 and a temporary helper that obtained its fixture
credentials with Docker inspect, injected them into the child environment, and printed no secrets.
The helper itself is not a repository dependency or a portable credential source.

```sh
TMPDIR=/tmp pnpm verify:integration
TMPDIR=/tmp pnpm verify:shared-path
TMPDIR=/tmp pnpm verify
```

The deliberate missing-DB negative is `env -u ITERM_DATABASE_URL node scripts/verify-integration.mjs`.
For the missing-browser negative, retain the isolated database environment and set
`ITERM_BROWSER_EXECUTABLE=/nonexistent/chrome` while running
`node scripts/verify-integration.mjs --shared-path`. Both must exit nonzero.

For repeatable performance evidence, with no other fixture suites running:

```sh
pnpm exec tsx scripts/benchmark-remediation.ts --output=docs/verification/review-remediation/artifacts/performance.json
```

The baseline defaults to the explicit pre-remediation revision in the script and can be supplied
with `--baseline=<hex-commit>`. Instrumented temporary source files and PTYs are cleaned on completion.
The script checks payload/frame hashes before reporting metrics. CPU/RSS are process measurements;
allocation counters cover named Buffer sites, not every allocation. Python fixture output temporarily
disables OPOST and restores it, ensuring byte-exact framing. Neither a microbenchmark nor one local
fault injection proves cross-platform, autonomous-model or long-running release L4 behavior.

Use a short `TMPDIR=/tmp` on macOS: Unix socket paths under the default long per-user temporary
directory can exceed the platform socket-name bound (observed `listen EINVAL`).

The real Console transport comparison is `pnpm exec tsx scripts/benchmark-console-stream.ts`.
It runs the exact baseline Console server and current Console against the same current backend,
then verifies that both WS clients actually received the final fixture output.
