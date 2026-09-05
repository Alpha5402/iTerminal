# ADR 0081: Opt-in Session authorization design

- Status: Draft — F03 design only, no Session ACL implementation
- Date: 2026-09-06

## Context and current boundary

D05 supplies stable, separately issued Agent credentials. Every current RPC requires an operation
allowlist; Actor-bearing requests additionally match the credential Actor and Application capability
rules. The current local mode shares Sessions. Actor-free reads, create, close, and execution-only
lookups do not acquire Session authorization merely because their grant contains an Actor.

See the complete [45-operation matrix](../plans/review-remediation/session-authorization-design.md).
ADR 0056 remains the implemented authorization contract. This proposal does not modify grants,
introduce an ACL flag, or change existing shared-mode behavior.

## Proposed decision

A deployment may explicitly select a future `session_scoped` authorization mode. The existing
`local_shared` mode remains the default. These are proposed configuration values, not supported
command-line options. A local administrator must choose the mode, inspect the migration preview,
and explicitly assign existing Sessions before enabling enforcement.

A verified request context carries the exact authenticated principal and Actor. Transport obtains
it from grant verification; body parameters cannot create or override it. Application receives a
narrow authenticated context for every read/write, including currently Actor-free methods. Session
permissions are an additional conjunction with existing capabilities, Actor type, Input Policy,
Guard, Approval, generation and fencing checks. They cannot bypass any of those checks.

Proposed durable records:

- `session_authorization(session_id, mode, policy_version, created_by_principal)`;
- `session_memberships(session_id, principal, permissions, version, revoked_at)`;
- workspace-level authority for root creation and local administration;
- an authenticated request context containing principal/Actor, verified operation scope, and mode;
- an audit fact for membership changes containing identities and version, never secret bytes.

Permissions are closed: `read`, `execute`, `input`, `control`, `close`, `checkpoint`, `fork`,
`rebuild`, `resize`, `policy`, `guard`, `approval_request`, `approval_decide`, `artifact`, and `secret`.
A signed session scope may further attenuate these rights; it cannot widen the database membership.
No unbounded list of Session IDs is added to every grant. A local administrator's bypass is explicit,
audited, and unavailable to ordinary Agent profiles.

## Ordering and revocation

Authorization is resolved before returning existence, metadata, counts, cursors, event/artifact
bytes, or cached results. For a mutation, membership/policy version is validated inside the same
Application admission transaction as the existing generation/fencing check. Owner and Router
cannot rely on a stale positive ACL cache to admit a write. An authorization-store outage fails
closed; it cannot become an empty discovery result or authorize an offline PTY write.

A queued, accepted Execute is rechecked before its first delivery attempt. Revocation before that
attempt cancels it with a durable reason. Once a write may have occurred, revocation does not
reclassify it as a harmless authorization denial, undo it, or replay it; existing UNKNOWN semantics
remain. Reconciliation disclosure itself requires current read rights. The administrator can resolve
revoked callers' outstanding actions without restoring their write permission.

Bounded reads check current membership before starting. Streams recheck at a bounded heartbeat and
before new event/artifact pages; revocation ends them. Already delivered bytes cannot be revoked.
The implementation must define and test the maximum read revocation delay before enabling the mode.
This proposal does not claim a zero-delay revocation guarantee.

## Routing and discovery

Router forwards the currently verified original credential and exact Actor scope, as it does today;
its own broad service grant cannot replace caller authority. Both Router's database candidate query
and the destination Application enforce the Session membership. Execution-only and Artifact IDs are
resolved internally to their owning Session, then authorized before metadata is returned. Owner
fencing remains independent of caller authorization.

Discovery SQL joins permitted membership before ordering and LIMIT. Counts are visible lower bounds,
and partial/unavailable owners include only already-authorized candidates. Cursor payloads bind
principal, query kind and policy version and are integrity protected. An invalidated membership
cursor produces a generic resync response without exposing formerly hidden Session IDs.

For an inaccessible or nonexistent Session/Execution/Artifact, public reads return the same generic
not-found response. A known accessible resource lacking a requested write permission returns
`POLICY_DENIED` (HTTP 403). Authentication failures are uniform and disclose no resource existence.
Raw database lookup timing is not a promised cryptographic non-enumeration boundary; endpoints must
be rate limited and tested for obvious metadata/count/cursor leaks.

## Approval and interactive programs

A Human must have both current `approval_decide` membership and existing `approval.decide`
capability. A proposal names an exact Agent, generation, command and Action key. An Approval adds
one condition for one top-level Execute; it does not grant Session membership, read authority,
subsequent REPL Input, Control, secret input, fork, or arbitrary commands. Giving an Agent `input`
authority for a running shell/REPL permits that program's byte interface and can have broad effects.
A UI must explain that authority before granting it; command-text heuristics cannot narrow it.

## Migration and old clients

1. Add tables and authenticated-context plumbing with shared mode unchanged.
2. Run an administrator-only inventory/preview mapping existing Sessions and stable principals.
3. Issue a versioned capability for scoped mode and deploy owner/Router/Console/MCP/CLI together.
4. Atomically create new Sessions and creator membership, keyed by authenticated principal plus
   idempotency identity. Fork requires parent checkpoint/fork rights; the child starts with an
   explicit membership set. Rebuild uses separate parent rebuild authority and creates a new PTY.
5. Enable scoped enforcement only after the matrix and counterexamples pass real multi-client tests.
6. Preserve durable policies on rollback. A scoped deployment cannot silently fall back to shared
   mode because an older peer/client appears; disable scoped service until an administrator acts.

Old grants/clients remain usable against shared mode. In scoped mode an old client is accepted only
when its authenticated context, operations, and explicit memberships suffice; absence of the new
protocol capability is a clear incompatibility before mutation. There is no automatic wildcard ACL
migration and no implicit grant to every browser cookie under an existing Human prefix.

## Administrator and operating-system boundary

Root and the same local OS user can read process memory or replace files/programs and can ultimately
act as the signing administrator. Mode 0600 and distinct Agent names do not provide strong isolation
between processes of that OS user. Strong tenancy requires separate OS/security boundaries and is
outside this proposal. Runtime checks protect cooperative clients and separately scoped credentials;
they do not claim an OS sandbox.

## Validation status

L0 design. The linked matrix covers all 45 current `operationSchemas` entries and includes 16
counterexamples. Existing `authorization-matrix`, `interaction-policy`, `approval`, `secret-input`,
and RPC authorization tests cover the underlying shared-mode layers; they do not prove Session ACL.
Implementation, migration tests and revocation/stream tests require a separate authorized milestone.
