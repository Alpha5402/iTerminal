# Session authorization: complete current RPC inventory

Status: F03 **L0 design only**. Baseline is the integration worktree on 2026-09-06; the 45 entries
below come from `packages/runtime-rpc/src/index.ts` `operationSchemas`. The proposal is
[ADR 0081](../../adr/0081-opt-in-session-authorization-design.md). No ACL code or grant migration is
included. HTTP, WS, CLI, and MCP must use these same Application checks, including when a tool
composes multiple RPC calls.

| RPC operation               | Current protection                                     | Proposed additional authority         | Scope and enforcement                                                   |
| --------------------------- | ------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------- |
| `action.lookup`             | Operation grant + credential Actor + Application rules | `read`                                | Session + own Action/authorized Human rules                             |
| `approval.decide`           | Operation grant + credential Actor + Application rules | `approval_decide`                     | Session + Human, exact pending version                                  |
| `approval.get`              | Operation grant + credential Actor + Application rules | `approval_request or approval_decide` | Session + own Agent proposal or Human                                   |
| `approval.list`             | Operation grant + credential Actor + Application rules | `approval_request or approval_decide` | Session; filter before page/count                                       |
| `approval.request`          | Operation grant + credential Actor + Application rules | `approval_request`                    | Session + Agent, exact proposed Execute                                 |
| `artifact.read`             | Operation grant; no Application Actor context          | `read + artifact`                     | Artifact owner Session; keep session/generation binding                 |
| `control.send`              | Operation grant + credential Actor + Application rules | `control`                             | Session + current Execution, policy/Guard                               |
| `events.query`              | Operation grant; no Application Actor context          | `read`                                | Session; recheck before each page                                       |
| `execution.get`             | Operation grant; no Application Actor context          | `read`                                | Resolve Execution to Session before disclosure                          |
| `execution.observe`         | Operation grant; no Application Actor context          | `read + artifact when dereferencing`  | Resolve Execution to Session; bounded bytes                             |
| `execution.output.read`     | Operation grant; no Application Actor context          | `read + artifact when dereferencing`  | Execution owner Session                                                 |
| `execution.dispatch`        | Operation grant; no Application Actor context          | `internal dispatch authority`         | Stored accepted Actor plus current membership before first write        |
| `execution.start`           | Operation grant + credential Actor + Application rules | `execute`                             | Session; capability/Approval/idempotency unchanged                      |
| `execution.wait`            | Operation grant; no Application Actor context          | `read`                                | Execution owner Session; no implicit cancellation                       |
| `execution.wait.v2`         | Operation grant; no Application Actor context          | `read`                                | Execution owner Session; cancellation stops wait only                   |
| `history.lookup`            | Operation grant + credential Actor + Application rules | `read`                                | Session + existing Actor disclosure restriction                         |
| `input.send`                | Operation grant + credential Actor + Application rules | `input`                               | Session + exact Execution; Execute Approval does not grant Input        |
| `secret.input.begin`        | Operation grant + credential Actor + Application rules | `secret`                              | Session + initiating Human, exact Execution                             |
| `secret.input.finish`       | Operation grant + credential Actor + Application rules | `secret`                              | Session + exact initiating Human and secret period                      |
| `secret.input.get`          | Operation grant + credential Actor + Application rules | `secret`                              | Session + Human; metadata only                                          |
| `interaction.get`           | Operation grant; no Application Actor context          | `read`                                | Session + generation                                                    |
| `interaction.guard.acquire` | Operation grant + credential Actor + Application rules | `guard`                               | Session + Human and existing policy                                     |
| `interaction.guard.release` | Operation grant + credential Actor + Application rules | `guard`                               | Session + exact Human holder                                            |
| `interaction.guard.renew`   | Operation grant + credential Actor + Application rules | `guard`                               | Session + exact Human holder                                            |
| `interaction.policy.set`    | Operation grant + credential Actor + Application rules | `policy`                              | Session + Human/System capability                                       |
| `terminal.resize`           | Operation grant + credential Actor + Application rules | `resize`                              | Session + policy/Guard + geometry CAS                                   |
| `terminal.state.get`        | Operation grant; no Application Actor context          | `read`                                | Session; advisory classification does not grant authority               |
| `screen.cells`              | Operation grant; no Application Actor context          | `read`                                | Exact Session/generation; same rule for HTTP/WS and RPC                 |
| `screen.frame`              | Operation grant; no Application Actor context          | `read`                                | Exact Session/generation; same rule for HTTP/WS and RPC                 |
| `console.observe`           | Operation grant; no Application Actor context          | `read`                                | Exact Session/generation; same rule for HTTP/WS and RPC                 |
| `screen.history`            | Operation grant; no Application Actor context          | `read`                                | Exact Session/generation; same rule for HTTP/WS and RPC                 |
| `screen.diff`               | Operation grant; no Application Actor context          | `read`                                | Exact Session/generation; same rule for HTTP/WS and RPC                 |
| `screen.get`                | Operation grant; no Application Actor context          | `read`                                | Exact Session/generation; same rule for HTTP/WS and RPC                 |
| `screen.region`             | Operation grant; no Application Actor context          | `read`                                | Exact Session/generation; same rule for HTTP/WS and RPC                 |
| `screen.search`             | Operation grant; no Application Actor context          | `read`                                | Exact Session/generation; same rule for HTTP/WS and RPC                 |
| `screen.wait`               | Operation grant; no Application Actor context          | `read`                                | Exact Session/generation; same rule for HTTP/WS and RPC                 |
| `session.close`             | Operation grant; no Application Actor context          | `close`                               | Session; add authenticated Application context                          |
| `session.checkpoint.get`    | Operation grant; no Application Actor context          | `checkpoint`                          | Session; never return environment values                                |
| `session.create`            | Operation grant; no Application Actor context          | `workspace create authority`          | Atomic creator membership; principal-bound idempotency                  |
| `session.fork`              | Operation grant + credential Actor + Application rules | `checkpoint + fork or rebuild`        | Parent mode/status selects fork vs rebuild; explicit child ACL          |
| `session.get`               | Operation grant; no Application Actor context          | `read`                                | Session existence protected                                             |
| `session.list`              | Operation grant; no Application Actor context          | `read`                                | Filter authorized Sessions before returning legacy array                |
| `approval.pending.list`     | Operation grant + credential Actor + Application rules | `approval_decide`                     | Human; ACL join before pagination and lower-bound count                 |
| `session.list.v2`           | Operation grant; no Application Actor context          | `read`                                | ACL join before candidate LIMIT and owner probing                       |
| `runtime.capabilities`      | Operation grant; no Application Actor context          | `workspace metadata or read`          | Global version only; target-owner metadata requires target Session read |

## Adapter and missing-context inventory

The Actor-free rows are concrete migration gaps: root create/close, dispatch and execution-only
reads/waits, Artifact/output reads, Session discovery/checkpoints, screen/history/Console observation,
events and interaction reads. Their transport grant currently limits operations, not Sessions.
They need verified context parameters at Application boundaries before scoped mode is enabled.

Console bootstrap and session-discovery use Session listing; `/stream` combines observation, events
and interaction reads and must apply all three checks. Its cached timeline, resumed cursors and
history overlay must be cleared on authorization loss. MCP output observation may dereference an
Artifact and therefore needs both output and Artifact authority. CLI `list/status/events/wait` must
not retain their current Actor-free gap. Worker dispatch is internal but cannot exchange a stored
Agent's authority for a broad System grant. Root health/readiness returns service health only;
private MCP bootstrap/credentials remain same-host administrator material and never contain an ACL
bypass token for a browser. No public `rebuild` RPC exists today: `session.fork` over the historical
checkpoint is the current rebuild path and needs distinct parent authorization in scoped mode.

## Counterexamples ready to become tests

| #   | Attempt                                                                | Expected scoped-mode result                                                                       |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Agent A puts B's Actor ID/principal in Execute body                    | Reject credential/Actor mismatch before admission                                                 |
| 2   | A has a valid read grant but guesses B's Session ID                    | Same generic not-found as nonexistent ID; no state leak                                           |
| 3   | A guesses B's execution ID using `execution_get` or either wait        | Authorize resolved Session before returning status or waiting                                     |
| 4   | A passes its Session ID with B's Artifact ID                           | Reject owner binding; disclose neither bytes nor Artifact metadata                                |
| 5   | A forges a history or discovery cursor from B                          | Generic invalid/resync; no hidden IDs, counts or ordering leak                                    |
| 6   | A may read Session but lacks input permission                          | Input rejected before PTY write even if screen/Execution is current                               |
| 7   | Human approved A's top-level Python Execute; A lacks input             | Later REPL line still denied; Approval grants no interactive authority                            |
| 8   | A may execute but lacks close permission                               | `session.close` denied even though its request formerly had no Actor                              |
| 9   | A may fork but cannot read parent checkpoint                           | Fork denied; no checkpoint/environment disclosure                                                 |
| 10  | A has fork rights but tries to rebuild a BROKEN parent without rebuild | Denied; no new child generation/PTY                                                               |
| 11  | Human has approval capability but no membership in B                   | B absent from inbox; guessed decide denied without proposal text                                  |
| 12  | Two Humans decide one authorized proposal version                      | Exactly one succeeds; other gets conflict, no implicit retry                                      |
| 13  | Router replaces A's credential with its broad owner credential         | Rejected by design; forwarding preserves exact caller context                                     |
| 14  | Membership revoked while Execute is accepted but not delivered         | Recheck then durable cancellation; if delivery already possible preserve UNKNOWN/completion truth |
| 15  | Membership revoked during WS/output pagination or old cache reuse      | End future observation at defined recheck boundary; clear client cache; no replay of bytes        |
| 16  | Old client connects to scoped deployment, or ACL DB fails              | Clear incompatibility/fail-closed; never silently enter shared mode                               |

## Existing tests and future evidence

`pnpm test:m10:authorization` covers credential/capability/type/policy/Guard/Approval/secret layers
used by examples 1, 6, 7, 11 and 12, but not the proposed per-Session membership conjunct.
RPC tests already check operation allowlists and forwarding Actor identity. D05's two real MCP
clients verify stable identities, not examples 2–5 or scoped tenancy. All membership, revocation,
non-enumeration, migration and rollback tests remain required for the future ACL implementation.
Local root/same-uid administrator power is explicitly outside strong-tenant isolation; see ADR 0081.
