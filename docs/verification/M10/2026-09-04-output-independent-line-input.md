# Output-independent foreground line input

## Incident and contract

The MCC task reported repeated SCREEN_CHANGED on an independently chosen foreground status
command despite no active Human Guard. Observed screen versions advanced during tool approval
and round-trip latency. Source inspection confirms that Input checked the complete screen
revision; ordinary asynchronous output increments that revision. InteractionState.version only
tracked policy/Guard changes, so using it alone would not protect partial Human input.

ADR-0065 adds an explicit lineInput precondition through Domain, Application, RPC, MCP and
PostgreSQL Action JSON. Ordinary input/screen CAS is unchanged. Independent printable LF-ended
commands to a known newline-delimited foreground interface use the observed input-context and
interaction versions. Pending/unknown input fails closed, including after Guard expiry. Private
Runtime CPR replies are not Human/Agent input mutations. The Application mutation lane and
durable owner fence remain authoritative; PostgreSQL also rechecks the latest relevant Action
sequence and interaction version before acceptance.

## Verification

Environment: local macOS arm64, real zsh/node-pty/Unix RPC, official MCP stdio client and isolated
iterminal_test PostgreSQL database. Separate test sockets, owner identities, temporary directories
and PTYs are used. No MCC/game commands, Input, Control, Close, or restart were sent to the user's
live Session. The fixture uses a real Node newline-delimited program emitting Chinese log output
every 20 ms. After observation, a 1.2-second simulated approval delay advances the screen by more
than ten versions; ordinary stale screen input is rejected, explicit line input is delivered and
acknowledged exactly once, including after same-key replay. This is not a real approval-provider
latency measurement or a recreation of the original 18-second call.

Covered checks:

- continuous output vs strict screen CAS and independent input-context CAS;
- Human partial input, fresh observation while still pending, and Guard expiry;
- Human input between observation and submission, two competing line requests, policy changes;
- wrong generation/Execution, identical-key replay, changed-precondition key reuse, UNKNOWN;
- printable Unicode line validation; reject multiline, raw keys, control characters and combined
  line/screen preconditions; unsupported editing leaves sticky unknown context;
- real MCP/PTY/PostgreSQL acknowledgement, persisted lineInput payload and one write-attempt;
- durable-only interaction-version race rejects before any Action is accepted;
- real canonical CPR does not change the Human input version or clear pending input.

Commands:

```sh
pnpm exec vitest run packages/application/src/input-context.test.ts packages/application/src/interaction-policy.test.ts
# ITERM_DATABASE_URL supplied privately and targeting only iterminal_test:
pnpm exec vitest run apps/mcp/src/line-input.test.ts apps/runtime-daemon/src/terminal-response.test.ts --maxWorkers=1
pnpm verify
```

Results: full verify passed formatting, lint, typecheck, 183 tests in 46 files, 53 report checks,
and production build. 107 environment-dependent tests in 33 files were skipped, not passed.
The separately enabled PostgreSQL/MCP/CPR run passed all seven tests in two files. A test-only
creation key was then made unique across reruns and the seven-case run passed again. The Vite
chunk-size warning remains non-fatal. During development, a sandbox Unix-socket restriction,
an approval timeout before execution, test typing errors, an incorrect live-output assertion
(Execution output is not the live Event stream), and a reused fixture creation key were fixed
or rerun with the proper isolated environment; they are not Runtime starvation evidence.

## Safe use after deployment

Read interaction_get for the exact generation. Only for a caller-known newline command
interface, with inputContext.state=clear and matching targetExecutionId, submit:

```json
{
  "sessionId": "<session>",
  "generation": 1,
  "targetExecutionId": "<active-execution>",
  "data": "/miner status\n",
  "lineInput": {
    "expectedInputVersion": 0,
    "expectedInteractionVersion": 1
  },
  "idempotencyKey": "<unique-intent-key>"
}
```

Numbers above are placeholders: use inputContext.version and interaction_get.version, not
screenVersion. This is not permission to omit a rejected screen-dependent precondition.
INPUT_CONTEXT_CHANGED requires re-observation and a fresh decision. Pending requires the Human
to finish their input; unknown remains conservative for the rest of that Execution. No command
is automatically resent and no new permission is acquired. This API does not model unsent
browser/IME drafts, arbitrary editor buffers, prompt transitions, or foreground-internal input.

## Deployment and separate live failure

Source and isolated L2 verification are complete; the online Runtime was not restarted and has
not gained this new contract. A new MCP process alone cannot upgrade the owner Runtime. Schedule
deployment explicitly; do not terminate online foreground programs to activate it implicitly.
This is not an online MCC acceptance claim, Human Console L3 result, or a general TUI solution.

A final read-only MCP check found the reported Execution already UNKNOWN, finished at
2026-09-04T06:51:39.118Z (14:51:39 +08), and its Session BROKEN. The exact Session's durable event
at 06:51:39.154Z records `PostgreSQL outage invalidated Runtime owner`. That generic recovery reason
does not identify database-server outage versus connection/lease failure. No owner restart or
control action was performed by this repair. The source task was notified not to send or replay
input against the old Execution. This owner-loss incident is separate from SCREEN_CHANGED.
