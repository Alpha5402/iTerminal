# Terminal copy fidelity and browser disconnect

## Scope and incident

The submitted command records contained actual LF bytes inside `bin/R` + `elease` and
`MinecraftClie` + `nt.ini`, before Shell dispatch. A read-only zsh reproduction confirmed that its
path error renders an embedded LF as the visible characters `\n`. The executor did not invent a
second backslash escape. The previous Console rendered all screen rows with CRLF, losing native
xterm soft-wrap flags and causing terminal-output copy to insert hard newlines.

ADR-0064 adds canonical wrap metadata, wrap-aware row diffs, clone isolation, and a Console copy
handler scoped to output selection. It does not modify pasted command grammar, raw PTY input,
historical commands, or sensitive-input policy.

## Checks

Environment: macOS arm64, Node.js 24.15.0, pnpm 10.33.2, real zsh/node-pty/Unix RPC,
PostgreSQL and the isolated `iterminal_test` database, real headless Chrome, official MCP SDK.
Temporary test workspaces and Sessions are cleaned by the harness; no game commands are sent.

- Six focused tests cover long paths/arguments, true multiline breaks, blank lines, spaces at a
  soft boundary, CJK/wide/combining characters, literal backslash-n, partial cell selections,
  missing legacy metadata, geometry mismatch, outside-viewport selection, wrap-only diffs,
  snapshot clone isolation, and alternate-buffer transition.
- The Browser scenario prints a two-line command containing a long temporary directory and CJK
  text through real MCP/Shell output. Actual mouse selection plus a ClipboardEvent/DataTransfer
  invokes the production copy handler. Copy is exactly the original text including the real line
  breaks. Filling that value into the READY editor and pressing Enter produces the same durable
  `executions.command` and a completed Shell exit code of zero.
- This copy test intentionally does not read or overwrite the OS clipboard. Platform-native
  clipboard integration is not a claim of this test.
- The same Browser goes offline and its WebSocket is terminated for 16 seconds (longer than the
  default 15-second owner lease). Runtime/PostgreSQL remain online. The Session stays READY,
  reconnects automatically without generation replacement, and a subsequent MCP command proves
  the same cwd remains in the persistent Shell.

Commands (database credentials supplied privately to the test process):

```sh
pnpm build:console
pnpm exec vitest run packages/terminal-screen/src/copy.test.ts packages/terminal-screen/src/index.test.ts
# With ITERM_DATABASE_URL targeting only iterminal_test:
pnpm exec vitest run apps/console/src/browser-shared-path.test.ts --maxWorkers=1
```

Focused results: 16 projection/copy tests passed; the new Browser copy/disconnect case passed.
The subsequent combined full Browser/projection/copy run passed all 23 tests across three files,
including all seven Browser scenarios (shared input, secret redaction, geometry, recovery and tabs).
`pnpm verify` also passed formatting, lint, typecheck, 177 tests across 44 files, document checks,
and the production build. Its 106 environment-gated tests across 33 files were skipped, not passed;
the PostgreSQL/Chrome cases above were run separately with the required environment. The existing
Vite chunk-size warning is non-fatal.

## BROKEN investigation

The two most recent user Session generations were reconciled at 2026-09-02 18:55:24 +08 with
`PostgreSQL outage invalidated Runtime owner`. That is the supervisor's generic recovery reason,
also used after heartbeat/lease failure; it does not establish a database server outage.

Local PostgreSQL logs around that time showed normal checkpoints and no server stop/start. macOS
power logs show sleep at 18:54:36 and DarkWake at 18:54:53, a 17-second pause. The configured local
stack uses the default 15-second database-time owner lease. This is consistent with sleep-related
loss of database/lease authority, but retained evidence does not distinguish an expired-heartbeat
error from a sleep-disrupted database connection. No Wi-Fi toggle or host sleep was injected.

Code inspection and the Browser offline test distinguish client disconnect from owner loss.
WebSocket close aborts observation and best-effort releases the Human Guard; it does not close the
PTY. ADR-0015/0042 deliberately close old PTYs after durable authority loss, settle ambiguous work
as UNKNOWN, and require new Sessions for recovery. This change does not weaken that fencing or
claim sleep-preserving single-host Sessions. More specific durable diagnostics and a sleep-aware
local lifecycle remain open TODO items.

## Test development and boundaries

Initial test attempts had harness errors (resize signature/version, geometry label, MCP wait
argument, and observing READY before the new Execution completed); those were corrected before
acceptance. An exploratory Console-process restart test also found that a fresh server Actor map
needs bootstrap before WebSocket reconnect; browser-only offline is tested separately, without
claiming unattended Console process-restart recovery.

This is L1 projection/selection coverage and L3 local Browser + official MCP + real Shell/PostgreSQL
copy/disconnect coverage. It is not autonomous-model acceptance, arbitrary scrollback copying,
Safari/Firefox/Windows clipboard parity, host sleep survival, or repository-wide release L4.
Old Runtime processes lack wrap metadata and must be explicitly updated; existing BROKEN
generations and previously corrupted commands are not automatically restored.

## Local activation

Immediately before updating the running stack, a read-only database check found zero
STARTING/READY/RESERVED/RUNNING Sessions. The verified local-stack process was gracefully stopped
and `pnpm local` restarted against the preserved state directory and PostgreSQL volume. A fresh
authenticated official MCP client created one disposable deployment-check Session, printed a
non-sensitive long fixture, and observed 40 wrap flags for a 40-row screen with a true soft wrap.
Only that newly created test Session was closed afterward. Historical BROKEN Sessions were not
deleted or claimed recovered. The Console returned HTTP 200 after activation; existing browser
tabs need reload to load the updated bundle.
