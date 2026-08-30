# M10.6 bounded PTY output Event coalescing verification

**Result: PASS at L2 for bounded UTF-8 PTY Event coalescing, exact attribution/order boundaries,
secret-output compatibility, and a real node-pty/zsh/PostgreSQL Artifact path.**

Date: 2026-08-31

Platform: macOS arm64, Node.js 22+, pnpm 10.33.2, PostgreSQL 17 Alpine in a disposable local Docker
container

## Scope

- Keep Virtual Screen writes synchronous with each sanitized Executor callback.
- Coalesce journal output at 8 KiB or 50 ms, whichever comes first.
- Split between Unicode code points without losing or reordering UTF-8 content.
- Flush before exact Action/Execution attribution changes and before non-output state Events.
- Preserve in-memory and durable Event IDs/payloads.
- Re-run the Human-only secret sanitizer/durability/Console/RPC suite.
- Re-run the existing real Chrome Human + official MCP shared-path suite as a compatibility gate.
- Prove that a real one-million-byte process write arriving through node-pty becomes bounded
  PostgreSQL Events and Artifacts.

## Commands and results

```sh
ITERM_DATABASE_URL=postgresql://iterminal:***@127.0.0.1:<port>/iterminal_test \
  pnpm test:m10:output
```

Result: 2 files and 10 tests passed. Application tests cover 1 KiB callback coalescing, 8 KiB hard
flush, 50 ms tail flush, three-byte Unicode boundaries, Event identity parity, and READY/RUNNING
attribution/state ordering. The real daemon suite covers M10.5 failure semantics and M10.6 live PTY
Artifact creation.

```sh
ITERM_DATABASE_URL=postgresql://iterminal:***@127.0.0.1:<port>/iterminal_test \
  pnpm test:m10:secret
```

Result: 5 files and 25 tests passed. Executor-first sanitization, Application sensitive-period
semantics, real PostgreSQL durability, Runtime RPC, and Console boundaries remain green with output
coalescing enabled.

```sh
ITERM_DATABASE_URL=postgresql://iterminal:***@127.0.0.1:<port>/iterminal_test \
  pnpm test:m5:browser
```

Result: 1 file and 4 real Browser Human + official MCP tests passed. The first run exposed a stale
parent `SESSION_BROKEN` error banner that survived selection of a successfully rebuilt READY child
and intercepted its Execute button. PostgreSQL showed the child was not broken. Clearing prior
errors at the exact Session-selection boundary fixed the UI race; the isolated historical rebuild
test and the complete four-scenario suite then passed.

```sh
pnpm verify
```

Result: format, lint, typecheck, default test suite, documentation evidence check, TypeScript build,
and Console production build passed. Database-dependent tests are separately evidenced above.

## Real PTY/PostgreSQL observations

A real daemon-created zsh executed:

```sh
python3 -c 'import os; os.write(1, b"X" * 1000000)'
```

For that exact Execution, PostgreSQL recorded:

- 124 `terminal.pty_output` Events instead of the pre-M10.6 roughly 987 callback-sized Events;
- 1,000,319 attributed output bytes including Shell/terminal framing;
- 122 Events referencing Artifacts;
- maximum Event content size 8,192 bytes;
- maximum Artifact size 8,192 bytes;
- zero missing Artifact references.

The metric query ran inside the test before Session close. Event count may vary slightly across
platform scheduling; the enforced assertions require more than 100 and fewer than 150 Events, at
least one million bytes, more than 100 Artifact Events, and both Event/Artifact maxima no greater
than 8 KiB.

## Not proven

- macOS x64, Linux x64/arm64, other node-pty versions, slow TTY producers, or a sustained
  multi-Session/high-cardinality output soak.
- End-user Browser latency measurement. The code path and tests preserve synchronous screen writes,
  but this report does not claim a measured 50 ms Human rendering SLO.
- Adaptive chunk sizing, compression, object-store offload, or per-tenant thresholds.
- Whole-database disk/WAL/backup bounds; M10.5 still counts only logical Artifact bytes.
- Reconstructing screen revisions from Event chunks. One Event may cover several callback-level
  `screenVersion` increments by design.
