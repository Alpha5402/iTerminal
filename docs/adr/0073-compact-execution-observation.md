# ADR-0073: Compact composed Execution observation

- Status: Accepted
- Date: 2026-09-05
- Amends: ADR-0002, ADR-0004, ADR-0048, ADR-0050, ADR-0068, ADR-0069, ADR-0071,
  ADR-0072

## Context

An Agent that already owns an Execution id currently has to coordinate the bounded wait from
ADR-0072 with the durable output cursor from ADR-0071. Repeating that composition in MCP clients or
the Runtime Router risks starting more than one business wait, treating an empty output page as
completion, or returning the full internal Action and Execution records merely to expose a small
observation.

PTY output is a merged byte stream and can contain ANSI controls or split a UTF-8 code point at a
page boundary. A compact view must preserve the exact sanitized bytes while making any convenience
text explicitly non-authoritative. It must also keep UNKNOWN reconciliation tied to the original
request identity without revealing or manufacturing an idempotency key.

## Decision

### Additive exact-scope contract

Application owns `observeExecution`. Runtime RPC exposes it as `execution.observe`, MCP exposes
`execution_observe`, and capable processes advertise `execution.observe.v1`. The strict request
contains `sessionId`, `generation`, `executionId`, optional B02 `cursor` and `maxBytes`, and optional
B03 `waitMs`. Output and wait retain their existing defaults and hard limits: 8 KiB / 64 KiB and
10,000 / 30,000 milliseconds respectively.

Before waiting, Application verifies that the live Execution matches the complete requested
Session/generation/Execution scope. A missing or cross-scope target produces the same
`EXECUTION_NOT_FOUND`; cursor details are not parsed or reported first. This is exact scope
consistency under an operation grant, not a per-Session Actor ACL. The latter remains F03.

The response is a fixed compact object containing only:

- `identity`: the requested Session, generation and Execution ids;
- `state`: the observed Execution state, terminality, and durable persistence-lag classification;
- `output`: one bounded merged-PTY base64 range, byte count, optional readable text, `hasMore`, and
  durable retention watermark;
- `nextCursor`: the ordinary continuous cursor or `null`;
- `gap`: the existing closed B02 Event/Artifact gap or `null`;
- `nextActions`: at most three values from `continue_output`, `wait_for_completion`,
  `acknowledge_output_gap`, and `lookup_original_action`.

It does not return command text, Action ids, Action payloads, Actor data, request hashes, exit
details, screen state, paths, tokens, or the complete internal Action/Execution records.

### One wait, then one immediate durable read

Application first performs the exact live-scope check, then invokes exactly one B03 wait with the
caller's signal and budget. After that wait settles normally, Application immediately performs one
B02 durable output read. The output read's Execution state is the response state because it is the
later observation and carries the matching durable persistence-lag boundary. A concurrent real
completion may therefore refine RUNNING to a terminal state, but lack of output can never do so.
If the wait has already observed a terminal state, the later read must report that same immutable
terminal state; an active or different terminal result is an impossible monotonicity violation and
fails explicitly as unavailable rather than returning `completed=false` or choosing one silently.

Timeout is an ordinary active snapshot. Cancellation aborts the one waiter and prevents the output
read; it does not send Control/Input, settle the shared completion, or release the Execution. The
Router forwards one `execution.observe` request to the exact owner with the same AbortSignal. It
does not call wait and output separately or start another business timer.

### Lossless bytes and bounded readable text

`output.contentBase64` is the authoritative sanitized PTY byte range. It always represents the
single B02 chunk, or the empty range when B02 returned no chunk. `stream` remains `pty`; no
stdout/stderr attribution is invented and ANSI bytes are not removed from the raw content.

For a complete UTF-8 range no larger than the convenience-text budget, `output.text` is a readable
projection. Newline, carriage return and tab are preserved; other C0/C1 terminal control characters
are rendered visibly rather than executed or deleted. This transformation does not use command or
echo regular expressions and cannot erase an ordinary printed line merely because it equals the
submitted command. `textStatus` is `complete`, `unaligned_utf8`, or `omitted_for_budget`; invalid
page-boundary UTF-8 never produces replacement characters. The convenience text is capped at 32
KiB encoded and omitted when the source range exceeds 8 KiB or the rendered text exceeds that cap.

The canonical schema correlates base64 length with byte count, terminality with state, persistence
lag with active/terminal state, text presence with text status, and next-action hints with the
actual page/state/gap. The complete structured result remains below 96 KiB. MCP returns the same
object in both `structuredContent.result` and the JSON text content for client compatibility. This
duplicates representation at the MCP boundary; it is not claimed as token reduction.

### Narrow next actions and UNKNOWN

`nextActions` is derived only from the concrete response:

- `continue_output` when the current continuous durable window has more bytes;
- `wait_for_completion` when the observed Execution is still active after the wait budget;
- `acknowledge_output_gap` when B02 reports a retention or Artifact gap;
- `lookup_original_action` when the observed Execution is `UNKNOWN`.

For UNKNOWN the caller must use `action_lookup` with the original authenticated Actor and original
idempotency key. Observation does not return, recover, or invent that key. An Artifact
`resumeCursor` remains inside the existing gap shape and must be deliberately adopted; the ordinary
`nextCursor` never silently skips the missing Artifact.

### Capability and compatibility

A direct owner advertises `execution.observe.v1` only when its gateway is configured with the
durable Execution-output reader required by the composition. An in-memory or injected Runtime is
conservative unless its composition explicitly opts in. The Router advertises its implemented
unscoped forwarding feature; scoped capability lookup remains the exact target owner's response.
Runtime grants authorize `execution.observe` separately.

Existing `execution_get`, `execution_wait`, `execution_wait_v2`, and `execution_output_read`
contracts are unchanged. No write command is added.

## Consequences

- Agents can execute and then make one bounded observation call without reimplementing ordering or
  completion rules.
- Raw output remains byte-exact and reconnectable under B02 retention limits; readable text is a
  bounded convenience view with explicit loss/boundary status.
- One response may still appear twice at the MCP protocol boundary because text and structured
  content are both retained for compatibility.
- Historical observation after live Runtime eviction still awaits B06; this decision does not use
  PostgreSQL to recreate a live PTY or waiter.

## Rejected alternatives

- **Compose in MCP or Router:** duplicates wait budgets and lets adapters own truth ordering.
- **Infer terminality from no output:** output silence is not a Shell completion fact.
- **Return the internal Execution/Action objects:** exposes command and Actor details and makes the
  public contract grow with internal models.
- **Decode with replacement characters:** silently corrupts UTF-8 across cursor pages.
- **Strip command-looking lines:** real program output may legitimately equal the submitted command.
- **Include an UNKNOWN idempotency key:** the observe request does not prove the caller's original
  request identity, and manufacturing a key could cause replay.
