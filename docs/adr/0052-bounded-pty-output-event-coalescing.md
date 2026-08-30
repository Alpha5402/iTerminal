# ADR-0052: Bounded PTY output Event coalescing

- Status: Accepted for M10.6
- Date: 2026-08-31

## Context

The Runtime currently turns every sanitized `node-pty` callback into one live Event and one durable
write. M3 moves an output Event to an Artifact only when that one Event exceeds 4 KiB. On the local
macOS/node-pty path, a one-million-byte process write arrived as roughly 1 KiB callbacks, producing
nearly one thousand inline Events and no Artifact. The Artifact threshold therefore bounds a
repository call but does not bound the real PTY callback path.

Coalescing inside PostgreSQL would be too late: Event IDs, sequence allocation, attribution, queue
pressure, and the in-memory Timeline have already been created. Coalescing inside the Executor would
delay the Virtual Screen and risks attributing buffered bytes to a later Execution after an
out-of-band Shell control message. The Application layer is the first place that owns both exact
Session/Execution attribution and the ordered durability queue.

## Decision

### Split live projection from journal chunking

Each sanitized PTY callback immediately:

1. increments the Session `screenVersion`;
2. writes the callback to the live Virtual Screen with that exact version;
3. appends the text to one generation-scoped output accumulator.

The Virtual Screen and Executor capture therefore stay callback-real-time. Only the append-only
Event/durable journal is delayed for coalescing.

### Hard byte and time bounds

One output Event contains at most 8 KiB of UTF-8 content. A partial accumulator flushes after 50 ms.
The first bound prevents one callback or event-loop burst from creating an unbounded Event; the
second prevents a quiet terminal from hiding a small tail indefinitely. Timer handles do not keep
the Runtime process alive.

Text is split only between JavaScript Unicode code points. Concatenating Event `data` in sequence
reconstructs the same sanitized string supplied by the Executor. ANSI/VT escape sequences may span
Events, just as they may already span PTY callbacks; the live Virtual Screen parses the original
callback stream and is unaffected.

At most one partial accumulator, strictly smaller than 8 KiB, exists per live Session. Flushed
bytes enter the existing per-Session durable queue and count toward its 8 MiB/10,000-operation
limits. The accumulator is not an additional unbounded retry queue.

### Attribution and ordering boundaries

An accumulator is keyed by exact:

- Session ID and generation;
- Action ID/Actor identity, or absence;
- Execution ID, or absence.

An attribution change flushes the old chunk before accepting new bytes. The chunk records the
first callback's observation time and the last callback's `screenVersion`.

The Application synchronously flushes pending output before it creates any non-output Event and
before every existing `flushDurable` mutation boundary. This includes Execution started/completed/
failed transitions, Input/Control/Resize actions, secret begin/delivered/finish events, policy and
Guard changes, fork/rebuild, query freshness, and graceful close. The durable queue receives the
flushed output before the following state transaction, preserving observation order.

The Executor remains the secret boundary. It suppresses raw sensitive output before calling the
Application. Secret begin already drains pre-secret output before enabling the sanitizer, and the
`sensitive_input.delivered` Event flushes the fixed redaction notice after the write attempt. A
chunk therefore cannot mix visible pre-secret bytes with raw sensitive bytes; raw sensitive bytes
never enter the accumulator.

### Failure semantics

A timer flush uses the same bounded durable queue and failure circuit as every other output Event.
Queue overflow or durable failure breaks the affected generation; it does not retain an unbounded
buffer or retry PTY bytes. Breaking a live Session clears any not-yet-flushed partial accumulator and
timer because the durable path is already untrustworthy. Graceful close, by contrast, flushes and
drains the accumulator before closing.

## Consequences

- Sustained real PTY output produces 8 KiB Events, which cross the existing 4 KiB Artifact threshold
  and exercise M10.5 storage admission.
- Event count and PostgreSQL transaction overhead become proportional to coalesced chunks rather
  than platform callback size.
- A small output tail can appear in the Event Timeline up to 50 ms after the live screen changes.
- `screenVersion` still counts raw observed callbacks, while an output Event records the last version
  covered by that chunk. One Event does not imply one screen revision.
- In-memory and durable Event streams keep the same chunk IDs, attribution, order, and payloads.

## Not covered

- Adaptive thresholds, compression, object-store multipart upload, or per-tenant tuning.
- Reconstructing a Virtual Screen from Event chunk boundaries.
- A cross-platform performance claim. The 8 KiB/50 ms defaults require later macOS/Linux soak and
  may only change through a documented compatibility decision.

## Rejected alternatives

- **Lower the Artifact threshold below observed callback size:** platform-specific callback sizes
  would still control Event/transaction cardinality and many small Artifacts would amplify storage.
- **Coalesce only in the repository:** leaves in-memory/durable Event identities and queue pressure
  inconsistent.
- **Coalesce in the Executor before sanitization:** delays live screen output and creates a secret
  leakage boundary outside the Application ordering model.
- **Flush only by bytes:** quiet tails can remain invisible indefinitely.
- **Flush only by time:** a single callback or event-loop burst can create an oversized Event.
