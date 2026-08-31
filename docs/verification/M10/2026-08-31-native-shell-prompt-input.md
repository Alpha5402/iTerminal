# M10.14 native Shell prompt input verification

**Result: PASS at L3**

## Scope

This report verifies that a READY Human command is edited at the canonical Virtual Screen cursor,
submitted as one ExecuteAction on Enter, and rendered by the real persistent Shell line editor as
the user's command. Private Runtime dispatch names and execution tokens must not appear in the
Virtual Screen. The implementation retains the out-of-band control FIFO and matching PTY barrier
for completion ordering.

Environment: Darwin 25.5.0 arm64, Node.js 24.15.0, pnpm 10.33.2, macOS bash 3.2.57, zsh 5.9,
Docker Engine 29.4.1, `postgres:17-alpine`, real node-pty, real Chrome, official
`@modelcontextprotocol/client` 2.0.0, and xterm.js. Browser/PostgreSQL/state fixtures used dedicated
ports, directories, containers, networks, and volumes and were removed after verification.

## Automated gates

```sh
pnpm exec vitest run --maxWorkers=1 \
  packages/executor-pty/src/native-shell-presentation.test.ts \
  packages/executor-pty/src/hostile-input.test.ts \
  packages/application/src/runtime-service.test.ts

pnpm exec vitest run --maxWorkers=1 \
  packages/executor-pty/src/pty-process-guardian.test.ts

ITERM_DATABASE_URL=postgresql://iterminal_test:<redacted>@127.0.0.1:55434/iterminal_test \
  pnpm test:m5:browser

pnpm verify
```

Results:

- native Shell adapter gate: bash and zsh rendered the submitted command without `__it_execute`,
  hid the PTY barrier, preserved multiline Shell state, and returned nonzero results for immediate
  syntax errors;
- existing Runtime gate: shared cwd/environment, Busy, targeted input, Ctrl+C, and idempotency
  remained green;
- Process Guardian gate: 2 passed with real host `ps`/TTY access; the sandboxed attempt could not
  inspect process identity and was not treated as product evidence;
- real Browser/MCP gate: 4 passed in the full suite; the final focused native-prompt rerun passed 1
  with 3 unrelated cases skipped;
- repository gate: 37 test files passed and 33 environment-gated files skipped; 139 tests passed and
  103 skipped; lint, typecheck, verification-document validation, and production builds passed.

## Real Browser observations

The real Chrome path created a zsh Session, waited for the READY editor, and established all of the
following:

1. The textarea editor was active and geometrically inside `.xterm-screen` at the Runtime cursor
   row/column; READY rendered no separate `.mode-panel` command dock.
2. The prompt contained the native-shaped `user@host cwd %` form while showing only the cwd's final
   component, so a long absolute path did not consume the command line.
3. A two-line `cd` plus `export` buffer retained its newline in the Browser editor. Enter submitted
   it as one ExecuteAction; the Virtual Screen contained the commands, did not report `cd: too many
arguments`, and did not contain `__it_execute`.
4. The same Session subsequently shared cwd/environment with the official MCP client, entered a
   real Python REPL, enforced the Human Interaction Guard, and returned to the prompt.
5. The page viewport remained fixed without requiring a document scroll to reach a separate READY
   input control.
6. A RUNNING command printed `Password:` and blocked on a real PTY read. The Console detected the
   prompt, mounted the Human-only password editor geometrically inside `.xterm-screen` at the
   canonical cursor, and removed the entire `.mode-panel` while secure editing was active. Enter
   used the existing SecretInputAction path; the sentinel remained absent from Console text, screen,
   MCP observation, Action/Event payloads, search, artifacts, and sensitive-input metadata while
   output redaction was active.

## Failed attempts and corrections

- The first geometry assertion read immediately after the status label changed to READY, one render
  frame before the overlay mounted. The regression now waits for the editor to become visible.
- Focus was initially asserted before the browser's autofocus frame settled. The editor now uses
  both `autoFocus` and the existing READY-transition focus effect, and the test waits for the active
  element explicitly.
- macOS bash 3.2 does not expose `READLINE_LINE`. Its first reserved escape binding therefore could
  not load a dynamic buffer. The final adapter adds the private command to in-memory history and
  recalls it through readline; persistent user history is disabled for the managed profile.
- The first managed prompt rendered the full cwd (`%~`/`\w`) and could consume most of a canonical
  line. The final prompt uses `%1~`/`\W`; checkpoints and shared cwd still retain the absolute path.
- The first secret-input UI placed its password field in the bottom RUNNING mode panel. The final
  presentation recognizes common password/passphrase prompts and places the transient password
  editor at the Virtual Screen cursor; unknown prompts retain an explicit manual secure-input
  control. This changes presentation only, not the Human-only/redaction persistence boundary.

## Not proven

- Loading and preserving arbitrary user bash/zsh rc files, prompt plugins, themes, aliases installed
  by startup files, shell frameworks, or a Terminal.app login banner such as `Last login`.
- Pixel-identical rendering across browsers, fonts, DPRs, Linux distributions, remote clients, or
  Windows/ConPTY.
- Full readline/ZLE editing parity such as history search, reverse-i-search, or completion menus.
  The Browser editor preserves and displays bounded multiline input, but it is not a complete native
  line-editor implementation; Enter still creates one ExecuteAction for the whole buffer.
- Hostile same-user containment. The private dispatch files/FIFO remain inside the ADR-0003 local
  trust boundary and are not an OS sandbox.
- Clean-machine packaging, two independent MCP client products, long-duration dogfood, or repository
  release L4.

## Conclusion

M10.14 closes the reported presentation gap for the verified local zsh Browser path and preserves a
tested bash 3.2 fallback: the Human sees and submits the actual command at a native-shaped Shell
prompt, while the Runtime's dispatch wrapper and execution identifier remain out of the canonical
screen. This is L3 evidence for the exercised Browser + official MCP + real zsh path, not general
terminal-emulator or user-shell-configuration parity.
