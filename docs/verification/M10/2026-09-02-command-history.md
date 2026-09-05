# M10.14 READY command history

**Result: PASS at L3**

## Scope

READY Up/Down navigation recalls commands into the inline editor without sending PTY input or
executing them. Commands come from the current Human Actor's `execution.started.observedCommand`
Events for the exact Session generation, not from terminal text, Agent commands, SecretInputAction,
or an unsubmitted draft. Existing available Events seed history when no cache exists.

The browser keeps up to 100 entries and 65,536 UTF-16 code units in a per-Actor/Session/generation
sessionStorage cache. Consecutive equal commands and repeated Event delivery are deduplicated;
ordinary screen updates do not rewrite unchanged history. Storage errors retain in-memory use.
This is editor recall, not a claim that earlier commands succeeded or that replay is safe.

Environment: macOS arm64, Node.js 24.15.0, pnpm 10.33.2, real Chrome, zsh/node-pty, official MCP
client, Runtime Unix socket, and isolated `iterminal_test` PostgreSQL at `127.0.0.1:55432`.
The user's Runtime and Sessions were not restarted or used for test commands.

## Gates

```sh
pnpm exec vitest run apps/console/src/command-history.test.ts
pnpm build:console
ITERM_DATABASE_URL=postgresql://iterminal:<redacted>@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run apps/console/src/browser-shared-path.test.ts \
    apps/console/src/command-history.test.ts
pnpm lint
pnpm typecheck
pnpm format:check
pnpm verify:docs
```

The full run passed four unit cases and four Browser integration cases. The shared Browser/MCP
case verifies:

- Up recalls recent Human commands in order, preserving a multiline command's exact text.
- Down returns toward newer history and finally restores the draft present before navigation.
- Explicit multiline and soft-wrapped draft interiors retain native textarea arrow movement.
  Modified arrows and a synthetic composing-key event do not invoke history recall.
- PostgreSQL still contains exactly two ExecuteActions after repeatedly browsing those two
  commands: arrow navigation produces no additional execution.
- Reload restores recall. Deleting only the test history cache and reloading also seeds history
  from the already-received Event cache, covering upgrades with existing commands.
- The same Session's Agent commands do not enter the Human history.
- A newly created Session has empty history; returning to the first Session restores its history.
- The existing shared cwd/env/REPL/Guard, secure input/redaction, geometry, and rebuild scenarios
  remain passing. RUNNING continues to use the existing foreground-program input path.

Unit cases additionally exercise Actor/generation key separation, malformed/unavailable storage,
entry/character bounds, stable navigation while new Events arrive, and reset after editing.

## Failure found during verification

The first Browser run failed after switching Session tabs: the old READY composer could remain
visible briefly, so a key could be handled before the new Session screen arrived and then cleared
by Session initialization. The editor now requires the selected Session identity and a current
screen before it becomes available. The focused rerun and subsequent full suite passed.

A later rapid-key rerun exposed delayed history caret placement racing with the next arrow key.
Caret placement now happens in the same layout commit as the recalled text, rather than in a
later animation frame that could undo a subsequent cursor move. The final full suite was rerun
after this correction.

## Not proven

- Complete host bash/zsh history, commands outside retained/received Events, or history shared
  across browser profiles. The cache is per browser tab and does not import `~/.zsh_history`.
- Full readline/ZLE parity, completion, reverse search, arbitrary prompt themes, every browser,
  or physical IME testing. Composition coverage here is a synthetic browser event.
- Restoration of unsent drafts across refresh; drafts are preserved during history navigation,
  not durably saved.
- Automatic terminal fitting or Runtime cursor-query responses. Those separately diagnosed
  issues are not changed by this history implementation.
- Repository-wide release L4.
