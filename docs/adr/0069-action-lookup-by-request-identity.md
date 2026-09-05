# ADR-0069: Action lookup by exact request identity

- Status: Accepted
- Date: 2026-09-05
- Amends: ADR-0011, ADR-0024, ADR-0048, ADR-0056, ADR-0058, ADR-0068

## Context

After a transport response is lost, a caller may know its Session, generation, authenticated Actor
and idempotency key but not the accepted Action ID. Existing retries can return an exact replay, but
that makes reconciliation look like another mutation and cannot distinguish a request that has not
arrived yet. Reading by Action ID would also create an object-reference authorization surface and
does not prove that the fact belongs to the caller's original request scope.

The in-memory Runtime store and PostgreSQL already retain accepted Action identity and outcome.
Normalized-fact retention may eventually delete terminal Action families, but it does not retain a
per-request tombstone. Therefore absence alone cannot prove that a particular Action expired.

## Decision

Application exposes a read-only lookup whose request contains the exact `sessionId`, generation,
idempotency key and authenticated Actor. RPC transports it as `action.lookup`; MCP exposes
`action_lookup`; Console exposes a semantically read-only POST route with a strict body so the
idempotency key is not placed in URL logs or browser history. Adapters bind Actor from their
existing authenticated context. No public lookup accepts an Action ID or an Actor body.

Authorization has two independent layers:

1. Runtime RPC requires an operation-scoped `action.lookup` grant and binds its Actor exactly;
2. Application validates the canonical immutable Actor and compares the complete accepted Actor
   identity, including type, principal, client and capabilities.

The idempotency scope remains Session plus Actor ID. Lookup additionally requires the exact stored
generation and verifies the complete Actor before returning any accepted fact. The durable request
hash remains an internal replay guard and is not returned: exposing it could provide a dictionary
oracle for commands or sensitive payloads. The lookup request accepts no replacement hash or
payload and cannot alter the accepted fact.

Application consults its current in-memory Action/Execution first. On a miss, a durable Runtime
queries PostgreSQL by Session, generation, Actor ID and idempotency key, verifies the immutable
Actor row, and projects only bounded metadata. It never hydrates or returns command text, ordinary
or secret input, control payload, workspace paths, or the complete Actor/capability record.
Lookup validates canonical Actor shape and compares any existing immutable binding without
registering a previously unseen Actor; actor registration remains part of accepted mutations.

The result is a discriminated union:

- `found`: exact request identity, Action ID/type/status and accepted time, plus the
  Execute-owned Execution ID/status when one exists;
- `not_found`: no retained accepted fact was found for the exact identity, with an explicit warning
  that the original request may still be in transit and a new key must not be generated
  automatically;
- `expired`: a future retention implementation may return this only with a request-specific durable
  tombstone and an observed expiry time;
- `unavailable`: durable lookup or exact owner routing could not establish an answer. The result is
  retryable as a read and is never converted to `not_found`.

The current implementation never returns `expired`, because existing Action retention has no
request-specific tombstone. A missing row after cleanup remains indistinguishable from a request
that never arrived and therefore returns `not_found` with the in-flight warning.

An immutable Actor mismatch returns the same bounded `not_found` result as any other non-match.
This deliberately avoids revealing that another principal, client, capability set or accepted
Action exists under the supplied Actor ID. Invalid Actor shapes and operation-grant failures remain
errors.

The Router resolves `sessionId` to the exact live owner and forwards the unchanged Actor-bound
lookup. A missing Session route returns `not_found`; route-database failure, a durable target with
no live owner, or owner connection failure returns `unavailable`. Authorization failures remain
errors and are never softened into a lookup result.

`action.lookup.v1` is advertised only by new daemons and Routers that implement this contract. A
client connected through a Router must inspect the exact target owner's capabilities; Router
capabilities are not a fleet-wide union.

## Consequences

Lookup never writes to a PTY, repeats an Action, changes an Action/Execution status, or allocates an
Action sequence. `UNKNOWN` is returned unchanged and remains unsafe to replay. A `not_found`
response is an observation at one instant, not rejection or cancellation of an in-flight request.
Definitively preventing a delayed request from arriving would require a separate admission/fencing
protocol and is outside this decision.

Old clients continue using existing operations. New clients must require `action.lookup.v1` before
using the lookup and need newly issued read grants containing `action.lookup`. Rollback removes the
additive query surface and feature; it does not rewrite retained Actions, Executions or Sessions.
