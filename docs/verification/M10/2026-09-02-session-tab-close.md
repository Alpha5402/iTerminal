# Session tab close verification

## Scope

Frontend tab lifecycle only. Existing Runtime close and historical BROKEN projection contracts
remain unchanged. Browser-local dismissal is not durable Session deletion or cross-client archival.
ADR-0024 records the distinction and metadata bounds.

Environment: macOS arm64, Node 24.15.0, pnpm 10.33.2, real Chromium, node-pty/zsh, PostgreSQL 17
on loopback, and the existing official MCP client integration fixture. Database scenarios are
restricted by the test harness to `iterminal_test`, not the user's `iterminal` database.

## Gates

```sh
pnpm typecheck
pnpm lint
pnpm build:console
ITERM_DATABASE_URL=<private-test-database-url> pnpm exec vitest run \
  apps/console/src/browser-shared-path.test.ts \
  apps/console/src/session-tabs.test.ts \
  apps/console/src/server.test.ts --maxWorkers=1
git diff --check
```

Initial sandbox execution of the server tests failed at Unix socket bind (`EPERM`), before scenario
execution. The permitted local integration run passed all 22 tests: six tab unit tests, ten Console
HTTP/WS tests, and six real-browser scenarios (including the existing MCP shared path).

## Covered behavior

- Independent, labelled close buttons, with no nested button markup; keyboard Enter can close.
- Closing a background live tab leaves the selected tab unchanged.
- Injected close HTTP failure keeps the tab and live Session present.
- Cancelling a RUNNING close preserves the running Execution; confirming closes the Session.
- Closing the selected tab chooses the right neighbor, then left. Closing the last tab clears the
  terminal display and leaves the new-Session button usable.
- Already CLOSED records do not appear as open tabs, including after reload.
- A same-owner historical BROKEN parent can be selected, inspected, and locally dismissed without
  a DELETE request. Its Runtime status remains BROKEN and the rebuilt child remains usable.
- Reload preserves that exact-generation dismissal. Unit coverage checks that a different
  generation is not hidden, invalid/unavailable storage is tolerated, and metadata is bounded.
- Historical BROKEN selection no longer requests the live-only Approval list and produces no
  SESSION_BROKEN error banner in the exercised scenario.

The in-app browser preview of the actual 4173 service also showed a close button on each open tab,
no nested buttons, hit boxes inside their tab bounds, no text overlap, and no error banner after
reload. The user's existing running program was not restarted or closed. Only static frontend
assets were rebuilt.

## Evidence boundary

Unit coverage is L1; the real Console/PTY/PostgreSQL and existing Browser + MCP shared-path
regressions reach the exercised local L3 path. This is not a general accessibility certification,
cross-browser matrix, durable archive feature, or a fix for local-stack startup/database lifecycle.
Dismissal is per browser origin/profile, retains only the latest 2,000 keys, and cannot survive
cleared/unavailable local storage beyond the current page. The live close confirmation uses the
latest fetched status; it does not introduce a new atomic server-side execution/version precondition.
