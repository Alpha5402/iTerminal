# ADR-0068: Runtime capability negotiation

- Status: Accepted
- Date: 2026-09-05
- Amends: ADR-0007, ADR-0029, ADR-0030, ADR-0059

## Context

Console and MCP clients can connect to a Runtime daemon or the central Router while those
processes are upgraded independently. Reading this checkout cannot establish what the running
process implements. In particular, a Router may forward different Sessions to owners with
different deployed builds and feature sets.

Execute and Input also had equivalent transport fields repeated in RPC, MCP and Console schemas.
That drift makes additive protocol work unsafe even when Application semantics remain unchanged.

## Decision

`@iterminal/protocol` owns canonical Zod transport schemas and DTOs. The package may depend on
domain types and constants; domain never depends on protocol. This change initially centralizes
the actor-free Execute and Input wire fields plus the capability request and response. Transport
adapters still bind the authenticated Actor and translate `generation` to Application's
`sessionGeneration`; transport schemas do not authorize a request.

Every new Runtime service implements the read-only `runtime.capabilities` RPC operation. Its
response contains only:

- `protocolVersion`: the wire compatibility generation, currently `1`;
- `buildId`: a bounded startup/build identifier, or the literal `unknown`;
- `features`: a sorted, duplicate-free list of features actually implemented by that process.

An additive operation or field does not by itself increment `protocolVersion`; an incompatible
wire change does. A feature is published only with its working handler. Build IDs come from the
explicit startup configuration and are never synthesized from source paths, credentials, grants,
or other host details. Invalid build IDs fail startup rather than being reflected to clients.

A direct owner answers an unscoped capability request for itself. The Router answers an unscoped
request with Router-only features. A request carrying `sessionId` is resolved through the durable
route and returns that exact owner's response. The Router never unions owner features or presents
one owner's features as fleet-wide support.

MCP exposes the same operation as read-only `runtime_capabilities`. Console performs a fresh
handshake for each bootstrap response. A matching protocol is `compatible`; a different
protocol is `incompatible`. If an older service explicitly reports that the RPC operation is not
supported, Console reports `legacy` and continues using existing endpoints. Other authentication,
validation, routing and availability errors remain errors. Consumers must check a named feature
before enabling its UI or behavior and produce an explicit unsupported-feature result otherwise.

Runtime RPC authorization continues to be operation-based. Grants that need negotiation must
include `runtime.capabilities`; the request contains no Actor body and reveals no Session facts
unless its optional `sessionId` is deliberately routed by a permitted caller.

## Consequences

New clients can distinguish legacy, compatible and incompatible running services without using
checkout state as evidence. Old clients continue using unchanged existing operations and ignore
the additive Console bootstrap field and MCP tool. Mixed-owner Routers expose owner truth per
target instead of a misleading aggregate.

This ADR does not migrate every historical transport schema, add feature negotiation to
Application state, or make PostgreSQL evidence of a live process. Later feature cards must add
their own feature only after implementation and tests exist.
