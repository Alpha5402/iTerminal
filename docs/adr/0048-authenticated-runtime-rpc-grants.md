# ADR-0048: Authenticated and scoped Runtime RPC grants

- Status: Accepted for M10.2
- Date: 2026-08-31

## Context

ADR-0047 makes Actor identity immutable and capability admission explicit, but the local Runtime RPC protocol still trusts the Actor serialized in a request body. Any process that can connect to the Unix socket can therefore claim the canonical Human profile. A central Router also creates a second trust boundary: authenticating only at the Router would let an unauthenticated caller bypass it and connect to an owner socket directly.

M10.2 needs one transport credential that:

1. limits which Runtime RPC operations a caller may invoke;
2. binds every Actor-bearing request to the identity and capabilities granted by an issuer;
3. survives a Router proxy hop without turning the Router into an authority escalation point;
4. represents non-Actor-bearing service calls such as Worker dispatch;
5. supports the Human Console's bounded, server-created cookie Actor namespace without granting arbitrary Human identities.

The boundary remains local and same-OS-user. It is not a sandbox against code that can read another process's environment, memory, or files with the host user's authority.

## Decision

### Signed bearer grant

Runtime RPC accepts a versioned bearer grant containing:

- a unique grant id;
- one exact audience;
- integer issue and expiry times;
- a non-empty canonical Runtime operation allowlist;
- one Actor scope.

The grant is a canonical JSON payload encoded with base64url and authenticated with HMAC-SHA256. The shared secret is canonical base64url for at least 32 random bytes. A grant lifetime is positive and at most 30 days. Servers allow 30 seconds of future clock skew for issuance and reject a grant at its expiry instant.

Tokens are bounded to 16 KiB. Unknown fields, versions, operations, Actor types, capabilities, duplicate or unsorted operation lists, invalid encodings, bad signatures, wrong audiences, and invalid times fail closed. Authentication failures return the same bounded `POLICY_DENIED` response and never expose the token or the precise verification failure.

### Actor scopes

Every grant carries one of two Actor scopes:

- `exact`: exact Actor id, type, principal, client, and canonical capability list;
- `paired_prefix`: exact type, client, and canonical capability list plus an id prefix and principal prefix. The suffix following both prefixes must be identical and non-empty.

`exact` is the default for MCP Agents and Worker/service identities. `paired_prefix` exists only for a trusted adapter that creates unpredictable Actors inside one bounded namespace. The Human Console grant therefore admits `human_console_<cookie-id>` together with `local-console:<cookie-id>` and cannot be used to claim a different Human identity, client, or capability set.

Actor-bearing RPC operations must match the grant before gateway dispatch. An operation without an Actor body is still limited by the grant's operation allowlist; its exact Actor scope identifies the authenticated service principal for future audit work but is not injected into domain state.

### Router forwarding and owner verification

The server records a grant in request-local context only after signature, audience, time, operation, and Actor-scope verification. A Router's outbound Runtime RPC client forwards only that verified token. A token supplied to a server running without authentication is not promoted into this context.

The owner Runtime independently verifies the forwarded grant against the same audience and trust key. Thus:

- a Router cannot convert an unauthenticated request into an authenticated owner call;
- bypassing the Router does not bypass authentication;
- the Router does not mint a broader identity or operation set;
- the original caller grant, rather than a Router service grant, remains the authorization fact.

Worker dispatch uses its own least-privilege exact service grant containing only the required non-interactive operations. Console and MCP processes receive their own grants. Production process entrypoints require explicit authentication configuration; test-only/in-process server construction may omit it only to preserve isolated protocol tests that are not security evidence.

### Configuration and handling

Servers receive the shared verification secret and audience through explicit runtime configuration. Clients receive an already-issued bearer grant. Empty credentials and malformed secrets fail startup. Tokens and secrets must not be written to logs, Events, Action payloads, error details, verification artifacts, or command examples containing real values.

Key distribution, rotation, and grant issuance are operator responsibilities in M10.2. Rotation requires replacing the server secret and all affected client grants together. Online revocation, asymmetric multi-issuer federation, remote transport, and an administrative issuance API are deferred.

## Consequences

- A request body can no longer self-promote to Human or add capabilities on an authenticated Runtime RPC path.
- Direct owner, Router proxy, and Worker paths use the same verifiable authorization fact.
- Router forwarding uses asynchronous request context; custom gateways must preserve the request promise chain if they expect automatic forwarding.
- HMAC keeps the local deployment small but every verifying Runtime can also mint grants if compromised. That is accepted for the defined single local trust domain, not for remote multi-tenant deployment.
- Bearer theft remains useful until expiry. Short grants, environment/file hygiene, and same-user host security remain operational requirements.
- The capability check in Application remains mandatory defense in depth; a valid transport grant never bypasses Input Policy, Interaction Guard, freshness, idempotency, or durable Actor identity rules.

## Rejected alternatives

- **Trust Unix socket mode alone:** socket ownership does not bind a request Actor and cannot distinguish Console, MCP, and Worker authority.
- **Authenticate only at the Router:** direct owner access would remain an authorization bypass.
- **Let the Router exchange the caller token for a service token:** loses end-caller Actor binding and gives the Router an avoidable escalation role.
- **Infer Actor from token and ignore the body:** would require invasive changes to every gateway contract and could silently attribute adapter bugs to the wrong Actor. Exact comparison fails such bugs closed.
- **One unrestricted local token:** authenticates possession but does not provide least-privilege operation or Actor boundaries.
- **Asymmetric signing now:** useful for independent issuers and remote trust domains, but adds key lifecycle complexity without improving the defined single-host threat boundary.
