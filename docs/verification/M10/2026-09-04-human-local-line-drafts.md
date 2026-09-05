# Human-local foreground line drafts

Date: 2026-09-04

Decision: [ADR-0066](../../adr/0066-human-local-line-drafts.md)

## Scope and environment

Local macOS arm64, real headless Chrome, real PTY/Shell, local PostgreSQL in the
isolated `iterminal_test` database, Console HTTP/WebSocket and official MCP client.
Test services are separate from the online Runtime and Minecraft Console Client.

Achieved: L3 for the tested local Browser + MCP interaction; L1 for input-context
classification. This is not an online MCC deployment or a general TUI compatibility claim.

## Verified scenario

`apps/console/src/browser-shared-path.test.ts` includes
`keeps Human foreground drafts local while Agent lines and logs continue`:

- A real foreground readline program emits Chinese background logs every 40 ms.
- Human enters a Chinese draft and presses Backspace. No InputAction is stored,
  no Guard is acquired, and input-context version/state remain unchanged.
- Agent submits its own newline-delimited command through MCP while that draft remains
  visible. The program acknowledges that command independently; the Human draft is intact.
- Human presses Enter. The program acknowledges the complete Human line separately;
  durable input records contain exactly the two submitted lines in order.
- Multiline foreground paste retains its newlines and is rejected rather than flattened
  or implicitly split into multiple commands. READY multiline Shell execution is unchanged.
- An aborted submission preserves the draft and prevents a second Enter from issuing
  another request for the same uncertain scope. There is no automatic replay.

The existing raw-mode Browser test now explicitly enables Advanced raw/TUI input and
continues to verify guarded key forwarding. Existing password, geometry, history and
recovery Browser scenarios also pass.

## Checks

- Focused new Browser scenario: 1 passed, 7 unrelated cases skipped by test-name filter.
- Full serial PostgreSQL-enabled run: Browser shared path, MCP line-input, and Runtime
  terminal-response suites: **3 files, 15 tests passed** (62.41 s).
- Application input-context, interaction-policy and secret-input suites: **15 tests passed**.
- Console production build, TypeScript typecheck, ESLint and `git diff --check` passed.
- Full `pnpm verify` passed: **183 tests passed, 108 environment-gated tests skipped**;
  formatting, lint, typecheck, verification-document checks and production build passed.
  The PostgreSQL-enabled 15-test run above supplies the separate real integration evidence.

## Boundaries and deployment

Default Human drafts are browser-memory-only and scoped to Session/generation/Execution.
The default editor does not expose typed draft content through observations. Submitted
ordinary lines are still normal audited Actions, not a secret-input channel.

Raw/TUI mode is explicit. Unsupported raw controls and delivery uncertainty may leave the
Execution input context unknown; switching modes does not clear it. BS/DEL now classify
as pending edits, but existing unknown live states are not rewritten or retrospectively fixed.
No Human confirmation/reset endpoint was added.

The online Runtime/MCC was not restarted or modified by these checks. Deploy Console
and Runtime together after coordinating interruption of live foreground programs. Browser
refresh alone cannot update an already running backend process.
