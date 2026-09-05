# ADR-0070: Bounded scoped Artifact reads

- Status: Accepted
- Date: 2026-09-05
- Amends: ADR-0004, ADR-0048, ADR-0050, ADR-0051, ADR-0056, ADR-0068

## Context

Large sanitized PTY output is durably stored as PostgreSQL `bytea` Artifacts and referenced by an
otherwise unchanged `terminal.pty_output` Event. The repository has an internal bounded read, but
it accepts only an Artifact id, defaults to the maximum 64 KiB, exposes the stored hash, and is not
available through Application, Runtime RPC, or MCP. An adapter cannot safely authorize a caller by
trusting the `sessionId` that accompanies an opaque Artifact id.

Artifact content may split a UTF-8 code point at any byte boundary. Decoding each page with a
replacement decoder would silently corrupt a text view even though the stored bytes are intact.
PostgreSQL can return a `substring(bytea)` rather than the whole value to the Node.js client, but a
TOASTed value may still require internal PostgreSQL decompression/read amplification. The public
contract must not overstate that storage implementation as zero-copy streaming.

## Decision

### Exact database scope and non-disclosure

Application exposes one read-only Artifact operation with the request fields `sessionId`,
`generation`, `artifactId`, `offsetBytes`, and optional `maxBytes`. The persistence query matches
all three durable ownership fields (`artifacts.id`, `artifacts.session_id`, and
`artifacts.session_generation`) before returning content or expiry facts. The submitted Session
identity is a lookup scope, not proof of ownership.

An Artifact missing from that exact scope and an Artifact that exists under another Session or
generation produce the same typed `not_found` result. The result only echoes the requested scope
and does not say whether the id exists elsewhere. An Artifact whose exact scoped row exists but has
expired produces `expired`; this distinction is revealed only after the complete durable scope
matches. A persistence failure produces typed retryable `unavailable`. These are read outcomes,
not Runtime state transitions, and they allocate no Action/Event/sequence and perform no PTY write.

Runtime RPC authorization remains an independent layer. `artifact.read` is an Actor-free read
operation protected by the signed grant's exact operation allowlist, consistent with the existing
observation operations described by ADR-0056. A denied or invalid grant remains `POLICY_DENIED` and
is not converted to `not_found`. Request-shape failures and an offset beyond an exact scoped
Artifact remain `INVALID_REQUEST`; they are not availability results.

This is scope-consistency enforcement, not a per-Session Actor ACL. A caller holding an
`artifact.read` operation grant is not separately proven to be a member of the requested Session;
that authorization model remains the later F03 boundary.

### Byte-range and response contract

The default `maxBytes` is 8 KiB and the hard maximum is 64 KiB. `offsetBytes` is a non-negative safe
integer. `maxBytes` is a positive safe integer no greater than the maximum. Oversized requests are
rejected rather than silently clamped. An offset equal to `totalBytes` is a valid empty EOF read;
an offset greater than `totalBytes` is invalid.

A `found` result contains the exact stored, already-sanitized bytes as base64 together with
`offsetBytes`, `returnedBytes`, `nextOffset`, known `totalBytes`, and `eof`. Therefore the actual
half-open range is `[offsetBytes, nextOffset)`. It contains no stored SHA-256 value: a public hash
would provide an unnecessary fingerprint for command or sensitive-period notice content. There is
no raw/unredacted switch.

PostgreSQL performs `substring(content FROM offset + 1 FOR limit)` so the client and transport do
not materialize the whole Artifact. The implementation and evidence explicitly retain the caveat
that PostgreSQL may internally read or decompress more of a TOASTed row. Artifact admission remains
bounded by ADR-0051's existing per-row maximum.

### MCP text view and compatibility

Runtime RPC returns the canonical base64 result. MCP returns that same structured result and may
add `text` only when the complete returned byte range is valid UTF-8 under a fatal decoder. It also
returns `textStatus: complete | unaligned_utf8`; on an unaligned range it omits `text` and tells the
caller to concatenate base64 bytes before decoding. It never inserts replacement characters or
silently discards a boundary byte.

The existing Event schema is unchanged. `artifact.read.v1` is advertised only by a running owner
whose gateway was explicitly configured with a durable Artifact reader. An in-memory Runtime or an
injected Runtime has no such feature unless its composition explicitly declares one. A Router's
unscoped response describes only Router behavior; a scoped capability request continues to return
the exact target owner's feature set without unioning.

## Consequences

- Clients can reconstruct sanitized binary output losslessly with bounded responses.
- Cross-Session guesses do not become an Artifact existence oracle, while an authorized exact-scope
  caller can distinguish retained from expired evidence.
- Base64 remains the canonical content representation; MCP text is convenience metadata with an
  explicit byte-boundary contract.
- Range size is bounded in Node.js and on the wire, but this decision does not claim constant-cost
  PostgreSQL TOAST access, object-store streaming, or whole-database resource bounds.

## Rejected alternatives

- **Authorize from the requested `sessionId`:** caller input cannot prove durable Artifact scope.
- **Read by Artifact id and compare after loading:** creates an existence oracle and needlessly
  materializes content before authorization.
- **Return the stored hash:** exposes a payload fingerprint without being required for paging.
- **Decode every page with replacement characters:** corrupts Chinese, emoji, or other UTF-8 split
  across byte ranges.
- **Advertise the feature for every LocalRuntimeGateway:** falsely claims support for in-memory or
  injected runtimes without a durable Artifact reader.
