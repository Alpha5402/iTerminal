# ADR-0071: Durable continuous Execution output cursor

- Status: Accepted
- Date: 2026-09-05
- Amends: ADR-0004, ADR-0048, ADR-0050, ADR-0052, ADR-0053, ADR-0068, ADR-0070

## Context

An Execution result retains only a bounded Executor byte ring. That ring can evict the leading
bytes of a UTF-8 code point, has no externally stable byte offset, and disappears with the live
Executor. It cannot serve a reconnectable continuous-output API. Durable
`terminal.pty_output` Events already preserve exact Execution attribution and numeric order; each
contains at most 8 KiB as inline text or an Artifact reference. Event retention and Artifact
retention can independently remove parts of that history.

An Agent needs a bounded continuation API that never presents a retained suffix as complete,
never infers stdout/stderr from a PTY, and never treats a currently empty durable tail as Execution
completion. The current live accumulator may be up to 50 ms behind the PTY and has no safe public
byte count, so a first version cannot truthfully merge it with durable content.

## Decision

### Durable-only source and exact scope

Application exposes `execution.output.read`; Runtime RPC and MCP expose
`execution.output.read` and `execution_output_read`. The request contains exact `executionId`,
`sessionId`, `generation`, an optional opaque cursor, and optional `maxBytes`. Persistence binds all
three identity fields in its Execution query. A missing Execution and an Execution under another
scope both produce `EXECUTION_NOT_FOUND`; lookup never fetches by Execution id and then discloses a
scope mismatch.

This version reads only durable `terminal.pty_output` Events. It does not inspect the Executor
Session or Execution byte rings and does not join an unpersisted live tail. `persistenceLag` is
`possible` for `DISPATCHING` and `RUNNING` because the PTY and 50 ms accumulator may be ahead of the
durable waterline. It is `none` for terminal Execution states because output is flushed and ordered
before the durable terminal Event. `hasMore: false` means only that no more retained bytes existed
at the database snapshot; callers must use `executionState`, not output silence, to decide whether
the Execution completed.

The stream is always `pty`. The API never invents stdout/stderr attribution and never removes
command-looking output or terminal echo with a regular expression. Content is the same
irreversibly sanitized byte stream governed by ADR-0050.

### Cursor and stable ordering

The opaque cursor is a bounded base64url encoding of a versioned payload containing only:

- exact Session, generation, and Execution scope;
- a fixed query fingerprint;
- one durable Event sequence and a byte offset within that output Event.

It contains no command, output, Actor, request hash, token, path, or timestamp. Continuation is
therefore stable across Runtime restart while the referenced Event/Artifact remains retained. The
cursor is not an authority: Runtime RPC operation grants are checked independently, and
persistence validates the cursor scope and anchor against the exact Execution output row.

Malformed, foreign-scope, future, non-output, wrong-Execution, or out-of-range cursors fail with
`RESYNC_REQUIRED`. A nonzero cursor whose anchor is at or below the effective Event deletion
watermark also fails with `RESYNC_REQUIRED` and `minimumAvailableSequence`; it is never silently
advanced. A cursor at the end of a retained output Event resumes at the next output Event, even
when unrelated Events lie between them.

### Retention gaps

Event retention and Artifact retention are independent facts:

- a fresh read reports an `event_retention` gap when the generation watermark has advanced and the
  retained exact-Execution Events no longer include `action.accepted`, so complete output from the
  Execution start cannot be proven;
- an output Event whose Artifact row exists but is expired reports `artifact_expired`;
- an output Event whose Artifact row no longer exists reports `artifact_missing`, including
  already-cleaned expired storage.

A gap is explicit and never filled with guessed bytes. A fresh `event_retention` gap describes the
missing historical prefix while the ordinary `nextCursor` continues only the retained suffix
returned in that response (or establishes the retained watermark when no suffix byte can yet be
returned). It has no second resume cursor. An Artifact gap blocks the current continuous window and
carries a separate `resumeCursor` at the end of the unavailable Event so a caller can deliberately
continue with the later retained suffix. For Artifact gaps, `nextCursor` advances only through
bytes actually returned before the gap and never skips it. A stale nonzero cursor remains a
resynchronization error rather than an implicit fresh read.

### Bounded response

`maxBytes` defaults to 8 KiB and has a hard maximum of 64 KiB. The response uses authoritative
base64 and contains at most one chunk, so per-Event metadata is not reflected as an unbounded
array. A repository page inspects at most 65 output Events; reaching that bound returns a
continuation even if many tiny Events do not fill the requested byte budget.

The canonical response schema bounds every identity, cursor, enum, and chunk field, validates the
base64 decoded length, and rejects a serialized response larger than 96 KiB. The existing Runtime
RPC envelope limit remains defense in depth rather than the only output budget.

`retention` reports the durable source and the effective minimum available Event sequence.
`gap` is either null or one bounded closed-shape reason. Artifact expiry metadata is not multiplied
into a per-Event list.

### Capability and cancellation

`execution.output.read.v1` is advertised by a direct owner only when its gateway was explicitly
configured with the durable output reader. In-memory and injected Runtime compositions remain
conservative. A Router advertises its implemented unscoped routing feature, while a scoped
capability request remains the exact owner's response.

The read is an immediate, read-only database operation: it creates no waiter, Action, Event, PTY
write, or Executor reference. Client cancellation or disconnection may abandon the response but
cannot close, interrupt, or release the underlying Execution.

As with ADR-0070, an `execution.output.read` operation grant authorizes the transport operation; it
is not a per-Session Actor ACL. That separate authorization model remains the F03 boundary.

## Consequences

- Output larger than the live ring can be paged without duplicates or omissions while its durable
  Events and Artifacts remain retained.
- Running output can be polled truthfully, but callers must accept an explicitly possible live
  persistence lag.
- Retention makes continuity conditional and visible rather than silently returning an incomplete
  suffix.
- The first version favors durable correctness over a lower-latency live-tail merge.

## Rejected alternatives

- **Page the Executor ring:** it has no stable reconnectable offset and may begin inside UTF-8.
- **Use array indexes or timestamps:** retention and interleaved Events make both unstable.
- **Join the current live accumulator:** it has no exact public waterline and would create overlap
  or loss races with persistence.
- **Return one chunk per Event:** tiny Events can make response metadata grow independently of the
  byte budget.
- **Treat missing Artifact bytes as empty:** silently changes an incomplete observation into a
  complete-looking output stream.
- **Sign cursors with a process-local secret:** restart would invalidate otherwise retained durable
  positions; exact scope and anchor validation provide the required non-authoritative boundary.
