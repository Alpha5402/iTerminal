# M10.14 multiline prompt layout regression

**Result: PASS at L3**

## Scope

Fix the READY command draft growing upward and being clipped when pasting multiple long lines.
This is a Console presentation change under ADR-0060: it does not change Action admission,
Shell dispatch, Runtime state transitions, or shared PTY geometry.

Environment: macOS arm64, Node.js 24.15.0, pnpm 10.33.2, real Chrome via Playwright,
real zsh/node-pty, official MCP client, Runtime Unix socket, and the dedicated `iterminal_test`
PostgreSQL database at `127.0.0.1:55432`. Test fixtures use temporary workspaces and an isolated
Runtime/Console. The user's live Runtime and existing Sessions were not restarted.

## Cause and correction

- The old editor subtracted its extra rows from the cursor's vertical position. A multiline draft
  therefore grew upward, covering history or leaving the top of the terminal.
- `wrap="off"`, a six-row cap, and a width derived only from the canonical 120-column screen caused
  clipping and horizontal scrolling when the visible terminal narrowed beside the inspector.
- The first visual line now starts after the existing prompt using a first-line indent; subsequent
  lines start at the terminal's left edge and grow downward. Actual textarea `scrollHeight` measures
  both explicit newlines and soft wraps, with no six-line display cap.
- Draft width is bounded by both the canonical screen and the visible terminal. The terminal
  surface is the shared scroll container for screen and editor. Caret movement reveals the active
  visual line without requiring the user to scroll the document to a separate input panel.
- Soft wrapping is visual only: the original command text, including newlines, is still submitted
  as one ExecuteAction on Enter. Resizing the browser does not resize the shared PTY.

## Automated gates

```sh
pnpm build:console
ITERM_DATABASE_URL=postgresql://iterminal:<redacted>@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run apps/console/src/browser-shared-path.test.ts
pnpm lint
pnpm typecheck
pnpm format:check
pnpm verify:docs
```

The full Browser suite passed all four cases. The first case now additionally verifies:

1. A two-line long-path/CJK draft at a 1309×1249 viewport with the inspector open starts on the
   prompt row, occupies more than three visual rows, and stays within the visible width without
   horizontal textarea overflow. Its raw value is unchanged.
2. Closing the inspector increases available width and reduces the number of wrapped rows.
3. A 120-line draft expands beyond the old six-row cap and scrolls inside the terminal to reveal
   its end. Moving the caret to the beginning scrolls back to the first line without altering text.
4. After a real Shell prints 45 history lines, a 12-line draft at a 1309×600 viewport grows below
   the near-bottom prompt and scrolls until its last line is visible.
5. The original multiline `cd` plus `export` scenario still executes successfully, keeps shared
   cwd/environment visible to the official MCP client, and does not expose private dispatch text.

The existing secure-input/redaction, controlled geometry, and durable rebuild Browser cases also
passed with the new scroll container. No sensitive-input value is used by the READY caret mirror.

## Visual check

An independent in-app browser tab loaded the updated local Console. A synthetic, unsubmitted
two-line draft confirmed that the first line follows the prompt, long text soft-wraps downward,
and the second command begins at the terminal's left edge. The draft was cleared and the temporary
tab closed; the user's original browser tab and unsent draft were not reloaded or overwritten.
The exact narrow viewport assertions above come from the isolated Playwright regression.

## Failed attempt and correction

The first bottom-prompt assertion sampled the layout before the scheduled caret-scroll frame.
Its initial wait only checked an already-existing scroll offset. The test now waits for the
editor's last line to enter the visible terminal before asserting the settled layout. The focused
rerun and subsequent full four-case run both passed.

## Not proven

- Pixel-identical behavior in Safari, Firefox, every font/DPR, or every desktop platform.
- Full readline/ZLE parity, completion, history search, or arbitrary user prompt themes.
- Arbitrarily large drafts or input-performance stress beyond the exercised 120 lines.
- Automatic shared PTY resizing, recovery from a lost generation, or reproduction of the user's
  Minecraft client command. Those behaviors are outside this layout change.
- Repository-wide release readiness or L4. These are local L3 Browser + MCP integration results.
