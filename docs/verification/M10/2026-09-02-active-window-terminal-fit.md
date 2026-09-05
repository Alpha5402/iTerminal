# Active Human window terminal fitting

**Result: PASS at L3**

## Scope and environment

ADR-0061 changes Console resize initiation, not Runtime ownership or Action semantics. A real
terminal pointer/key interaction activates fitting for the visible, focused Human window.
Its viewport changes produce debounced, version-guarded ResizeActions. Canonical snapshots
remain the only source of browser xterm geometry. Advanced retains an opt-out/manual form.

Environment: macOS arm64, Node.js 24.15.0, pnpm 10.33.2, real headless Chrome, official MCP
SDK client, Runtime Unix socket, node-pty/zsh, Python SIGWINCH fixture, PostgreSQL 17 in isolated
`iterminal_test` at `127.0.0.1:55432`. Existing user Sessions and Runtime were not restarted
or used for commands. The production Console assets were rebuilt for the existing server.

## Commands and results

```sh
pnpm build:console
ITERM_DATABASE_URL=postgresql://iterminal:<redacted>@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    apps/console/src/browser-shared-path.test.ts \
    apps/console/src/command-history.test.ts \
    apps/console/src/terminal-fit.test.ts \
    apps/runtime-daemon/src/resize.test.ts
pnpm lint
pnpm typecheck
pnpm format:check
pnpm verify:docs
git diff --check
```

The final focused run passed 4 files / 18 tests: 5 Browser scenarios, 7 fitting unit tests,
4 history unit tests, and 2 real Runtime resize tests. Static checks and the Console build
passed. Vite retains its advisory chunk-size warning above 500 kB.

## Observed scenarios

- Before Human terminal interaction the new Session stays 120×40/version 1. Clicking the
  inline editor in a 1309×1249 viewport creates version 2 and uses more than 40 rows.
  The measured rendered grid fits the available width/height to within one cell.
- A 120-line unsent draft does not create another resize or change command bytes.
- A real foreground Python process reports the same kernel PTY size seen through MCP.
  Shrinking the window to 1100×850 creates version 3; the SIGWINCH handler reports the
  new columns and rows. Opening the Session inspector creates version 4 with fewer columns.
- A second same-context browser tab connects at a different viewport. Loading, resizing the
  passive tab, and resizing the background first tab leave the geometry at version 4.
  Playwright normally forces every headless page to appear focused: the test disables that
  CDP focus override for the background tab and asserts `document.hasFocus() === false`.
- Clicking the second tab's terminal creates version 5. Both viewers show that canonical
  geometry, and bounded settling checks find no competing resize loop.
- An official MCP Agent resize creates version 6. The active Console does not immediately
  overwrite it upon receiving the snapshot. Reload alone does not resize either. PostgreSQL
  contains exactly five ResizeActions for the five version advances.
- The existing explicit Human/Agent resize test still proves stale CAS rejection, screen
  diff resync, real SIGWINCH, text parity, and durable attribution. Manual submission leaves
  automatic fitting disabled in that page.
- Runtime resize tests retain Guard admission and post-write failure behavior: uncertain
  delivery remains UNKNOWN/BROKEN, not an automatic replay.
- Browser history/multiline editing, secret redaction, and durable rebuild regressions pass.
  The original draft-layout case explicitly disables fitting to preserve fixed-geometry
  overflow coverage; automatic geometry has its separate scenario above.

Unit tests additionally cover metric flooring/clamping, unmeasured layouts, passive observation,
debouncing, one request waiting for HTTP plus canonical acknowledgement, later-layout coalescing,
equal-size no-ops, hidden/disposed requests, rejection requiring fresh interaction, and uncertain
delivery locking further automatic requests.

## Verification adjustments

Initial multi-window attempts used independent contexts with Playwright's forced-focus override;
both pages reported foreground state. The final scenario uses two tabs in one context, releases
the background focus override, and checks focus explicitly rather than claiming OS-window
coverage. A separate first full-suite failure came from opening Advanced before an existing
autofocus assertion; the setup now checks initial focus before selecting fixed geometry.
The final complete focused run passed after these test setup corrections.

## Not proven

- Multiple physical OS windows, browsers, or remote hosts under simultaneous Human activity;
  there is no new distributed exclusive-viewer lease. Runtime geometry CAS still arbitrates.
- Every zoom/font/DPI combination, mobile virtual keyboards, Linux/Windows/Safari/Firefox,
  arbitrary TUIs, or long-duration resize storms.
- Unlimited terminal size: the existing 40–240 column / 12–100 row bounds still apply.
- Terminal cursor-query replies, the separately diagnosed .NET input issue, scrollback parity,
  or full native-shell editing equivalence. This change only handles shared geometry.
- Repository-wide release L4, clean-machine installation, or the user's live Minecraft path.
