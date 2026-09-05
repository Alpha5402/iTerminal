# Runtime cursor replies: .NET input stalls and corruption

**Result: PASS at L2**

## Scope and cause

The canonical headless terminal already parsed CSI 6 n but discarded its cursor-position reply.
The Runtime now routes only bounded CSI row ; column R replies through private, attributed
System InputActions. Exact generation/foreground targeting, durable acceptance/write-attempt,
and unknown-delivery rules remain intact. Public System Input, including forged provenance,
is still denied. See ADR-0062 for the narrow policy exception and limits.

Environment: macOS arm64, Node.js 24.15.0, pnpm 10.33.2, real node-pty/zsh, .NET SDK 10,
PostgreSQL 17 at loopback in `iterminal_test`. The user explicitly authorized testing their
existing Minecraft Console Client executable against their game server. No account name,
address, password, raw terminal transcript, or config copy is included in this report.

## Actual client reproduction

The executable and BasicIO-NoColor mode were unchanged. Testing used a private temporary copy
of the original configuration with file logging and Sentry disabled; ChatLog was already off.
The original configuration was not edited. The login command was supplied through non-echoed,
transient stdin; diagnostic output contained only counters and boolean status, not terminal text.

1. With terminal replies disabled, the actual client connected and successfully logged in.
   Ordinary sequential login input did not reproduce corruption.
2. Entering `/helpp`, Backspace, Enter emitted CSI 6 n. No output progress occurred for roughly
   ten seconds. Replacement characters then appeared in the client's PTY output: 11 at about
   12 seconds, 73 at about 15 seconds. This was upstream of browser rendering.
3. Enabling cursor replies in that same isolated experiment stopped further corruption growth
   after the pending input settled. Already damaged text was not repaired.
4. A fresh instance of the same client was then run through the patched iTerminal Runtime
   and normal Application InputActions. It reached server join; `/helpp` + Backspace + Enter
   produced one delivered System reply and no replacement characters. A local `/help` input
   containing Chinese text plus Backspace produced a second reply and still no replacement
   characters during the following roughly 66 seconds.

The post-fix client run proves the affected local editor path after server join, not another
successful server-authentication cycle: its login-success flag was false. The pre-fix run above
is the actual authenticated reproduction. Temporary clients were stopped and private configs,
backups, and diagnostic scripts were removed; the user's original Runtime was not restarted.

## Automated verification

```sh
ITERM_DATABASE_URL=postgresql://iterminal:<redacted>@127.0.0.1:55432/iterminal_test \
  pnpm exec vitest run --maxWorkers=1 \
    apps/runtime-daemon/src/terminal-response.test.ts \
    packages/terminal-screen/src/index.test.ts \
    packages/domain/src/terminal-response.test.ts \
    apps/console/src/browser-shared-path.test.ts \
    packages/application/src/authorization-matrix.test.ts \
    packages/application/src/secret-input.test.ts \
    apps/runtime-daemon/src/secret-input-durable.test.ts
pnpm verify
```

The focused integration run passed 7 files / 31 tests. Coverage includes:

- Split queries and multiple cursor positions in one parser write: exact parse-time coordinates
  and source revision; no response caused by snapshots/diffs, DA, or clipboard queries.
- Real Python raw-PTY query answered through System InputAction while a Human Guard is active;
  accepted → write_attempted → delivered ordering, exact identity, and PostgreSQL JSON provenance.
- Public `sendInput` rejects the reserved System identity even when the caller supplies a
  `terminalResponse` property; bounded shape tests reject arbitrary bytes and malformed coordinates.
- A real .NET 10 Console.ReadLine fixture returns `/help`, `中文测试`, and `中文🙂` after backspace
  and Unicode input within each 2-second assertion window, without U+FFFD, then completes.
  The .NET case is explicitly skipped on hosts without SDK 10; it ran on this machine.
- Post-write fault: exactly one reply write, Action UNKNOWN, Session BROKEN, no retry.
- Query flood: bounded response collection/queue and explicit BROKEN, rather than unlimited
  generated input. The parser collects at most 33 replies per write; Application allows at most
  32 pending replies and 120 responses per second per Session.
- Existing Console/MCP, authorization, secret-channel, and redaction tests remain passing.

The repository `pnpm verify` gate also passed: 41 test files / 160 tests passed, with 33 files /
104 environment-gated tests skipped in the default run. Formatting, lint, typecheck, verification
document checks, TypeScript build, and Console build passed. The separate focused run above
supplied the isolated PostgreSQL connection for the new durable scenarios. Vite retains the
existing advisory warning for a JavaScript chunk above 500 kB.

## Not proven

- The current user browser could not be inspected because its browser operation was denied by
  the safety check. No alternate browser surface was used to bypass that restriction. Existing
  isolated Browser/MCP regression cases ran, but this repair is not claimed as a new L3 browser
  acceptance of the user's exact live Session.
- The old running Runtime does not hot-load this repair. Activation requires an authorized
  service restart and fresh live PTYs; existing corrupted screen content cannot be reconstructed.
- Queries wholly suppressed during an active sensitive-output period remain suppressed. No
  hidden raw secret screen was introduced. Other query families and full secret-period terminal
  emulation are outside this repair.
- Arbitrary .NET versions, TUIs, host locales, all Unicode editing combinations, cross-platform
  behavior, end-to-end latency budgets, or release L4.
