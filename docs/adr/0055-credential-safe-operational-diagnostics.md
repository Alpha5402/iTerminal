# ADR-0055: Opaque Runtime grants and credential-safe operational diagnostics

- Status: Accepted for M10.9
- Date: 2026-08-31

## Context

ADR-0048 requires Runtime RPC grants and verification secrets to stay out of logs, Events, errors,
and verification artifacts. Authentication failures already use one fixed response, and the Unix
socket is mode `0600`. Those controls do not cover accidental diagnostic disclosure after a grant
has been verified or while a database/broker connection is failing.

The verified-grant value currently contains an enumerable bearer token, and `UnixRuntimeClient`
stores its configured token in an enumerable constructor property. A generic object logger could
therefore disclose either value without any code explicitly logging `ITERM_RPC_GRANT`. Runtime RPC
also forwards unknown exception messages and transport failure reasons to peers. PostgreSQL and
RabbitMQ recovery supervisors place driver `Error.message` values into public state callbacks;
the relay can then persist a RabbitMQ publish/connect message as an Outbox retry reason. Driver
messages are not a credential contract and may contain connection URLs, user information, query
parameters, local paths, or future library-specific context.

The grant issuer intentionally emits newly created credential material. Treating this explicit
secret output as an ordinary log would either make issuance unusable or hide the actual boundary.

## Decision

### Opaque in-process credential representation

A verified Runtime RPC grant exposes claims only. Its bearer token is held in package-private weak
storage and is retrieved only by the explicit Router-to-owner forwarding path. Serializing a
verified grant cannot serialize its token. `UnixRuntimeClient` uses JavaScript private fields for
its socket path and optional authorization value, so ordinary enumeration and JSON serialization
cannot expose the configured grant.

This is accidental-disclosure hardening, not process-memory encryption. Code in the same process
that can read environment variables, instrument the transport, or deliberately call the forwarding
accessor remains inside the same trusted OS-user boundary.

### Runtime RPC error boundary

Authentication failures remain one fixed `POLICY_DENIED` response. Schema failures return a fixed
invalid-input message rather than formatted validator output. Unknown server failures return a fixed
retryable Runtime-unavailable response with no original message or details. Client-side transport
failures preserve operation, request ID, delivery certainty, and a bounded code-only diagnostic;
they never copy `Error.message`, `cause`, socket request bytes, or authorization into RuntimeError
details.

Known Application `RuntimeError` values keep their domain message and metadata. Before sending one
from an authenticated request, the RPC boundary checks its serialized public error shape for the
exact active bearer. If found, it replaces the whole public error with the fixed internal-failure
response. This is a final invariant guard, not a general-purpose arbitrary-secret detector.

### Code-only operational diagnostics

Reusable operational error summarization accepts a programmer-owned fixed fallback and, when
present, an error code from a closed network/domain allowlist or the five-character PostgreSQL
SQLSTATE grammar. It never reads or stringifies `message`, `cause`, connection input, or an
arbitrary thrown value. PostgreSQL and RabbitMQ connection supervisors, Runtime PostgreSQL
recovery, and RabbitMQ publisher retries use this summary before exposing state or durable retry
text.

This deliberately trades some raw driver detail for a stable security boundary. Endpoint index,
attempt, backoff, component, operation, and safe driver/domain code remain available. Deep driver
diagnosis belongs in an explicitly enabled secure diagnostic channel designed later; ordinary
stderr, state callbacks, Runtime RPC errors, Outbox retry facts, and verification evidence are not
that channel.

### Explicit issuer output

`rpc:grant` stdout remains a credential channel, not a log channel. Documentation must pipe it
directly into a repository-ignored mode-`0600` credential file and must not place real values in
examples or verification evidence. Process supervisors must not run the issuer as a service whose
stdout is collected as ordinary logs. The issuer's stderr remains metadata-only validation text.

## Consequences

- Generic object logging no longer serializes configured or verified Runtime RPC grants.
- Invalid input and unexpected exceptions lose raw validator/driver detail at the RPC boundary.
- PostgreSQL/RabbitMQ recovery remains diagnosable by component, endpoint index, attempt, delay, and
  safe code without trusting dependency error wording.
- RabbitMQ connection/publish failures cannot place a connection URL from a driver message into the
  durable Outbox retry reason.
- This contract can prove exact sentinels absent from current public diagnostics, but it cannot prove
  arbitrary process memory, debugger, crash dump, shell tracing, or third-party custom logger safety.

## Not covered

- Online grant revocation, key identifiers, asymmetric issuers, remote transport, or multi-user
  isolation.
- A privileged secure debug sink, encrypted crash reporting, core-dump/swap policy, or host log
  retention.
- Shell marker/path hostile-input review, HTTP request-rate limits, and the remaining resource
  exhaustion matrix.
- Redaction of secrets deliberately printed by commands into the PTY outside the Human secret-input
  lifecycle.

## Rejected alternatives

- **Regex-redact every error message:** an arbitrary bearer has no reliable lexical signature, and
  library message formats can change. Preventing raw messages from crossing the boundary is simpler
  and stronger.
- **Sanitize only the CLI print sites:** state callbacks and durable retry reasons would still expose
  dependency messages to other consumers.
- **Keep the token enumerable but promise not to log it:** accidental structured logging remains a
  one-line disclosure.
- **Remove issuer output entirely:** operators still need a credential creation channel. Naming and
  documenting the explicit sink is more honest than conflating it with ordinary telemetry.
