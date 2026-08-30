# ADR-0044: PostgreSQL quorum authority and primary endpoint failover

- Status: Accepted for M9.16
- Date: 2026-08-30
- Refines: ADR-0015, ADR-0029, ADR-0038

## Context

M8.6–M9.15 fail a Runtime or Router closed when its single PostgreSQL path becomes unavailable. That is safe, but a healthy database majority cannot restore application progress while every process keeps reconnecting to the failed address. A list of database addresses alone is also unsafe: a physical standby can accept a connection while remaining read-only, and an isolated former primary can still identify itself as a primary even when synchronous commit can no longer reach the configured standby quorum.

iTerminal must not invent database consensus. Runtime owner leases, Session fences, placement claims, idempotency rows, Actions, Events, Outbox, and Inbox all require one externally authorized writable PostgreSQL primary. Promoting a standby is an operator or database-control-plane decision. Application processes may discover the promoted primary from a bounded configured endpoint list, but they must never promote a node, compare timelines, or retry an ambiguous business transaction automatically.

## Decision

### Authority and topology

- Production PostgreSQL HA is externally managed. The database control plane owns replication, synchronous-commit policy, failure detection, fencing of the former primary, promotion, timeline repair, and replica rejoin.
- M9.16 verification uses one primary and two physical standbys. The initial primary requires one synchronous standby acknowledgement (`ANY 1`) so pausing both standbys removes commit availability from the minority primary.
- The test first proves that the still-running minority primary cannot commit a Runtime heartbeat within the configured statement deadline. It then explicitly stops that former primary before promoting a standby. Application endpoint rotation is not a split-brain resolver.
- A promoted standby becomes eligible only after PostgreSQL reports that recovery has ended. A server still in recovery is rejected even if the TCP/TLS connection succeeds.

### Ordered application endpoints

- Durable PostgreSQL adapters accept one connection URL or an ordered, non-empty URL list. A single URL preserves existing behavior.
- `ITERM_DATABASE_URLS` supplies a comma-separated list for production Runtime and Router processes. `ITERM_DATABASE_URL` remains the backward-compatible single-endpoint fallback. Supplying both is invalid rather than silently choosing one.
- Every newly created client advances round-robin through the endpoint list. A connection is admitted to its pool only when `pg_is_in_recovery()` is false and `transaction_read_only` is off.
- Connection/administrative shutdown, read-only transaction, client-side connection/read timeout, or transport loss retires that client and advances the next connection attempt. An ordinary PostgreSQL statement cancellation remains a query failure and does not rotate endpoints. The failed operation is always returned to its caller; the pool does not replay it on another endpoint.
- Endpoint state exposes only a zero-based index. URLs, usernames, passwords, certificates, and query text never enter availability diagnostics.

### Runtime and Router recovery

- The existing supervisors remain the only retry loops. A failed Runtime durable write triggers owner-wide fencing, local PTY destruction, and `BROKEN/UNKNOWN` reconciliation before readiness can return.
- A Router in a database outage keeps its stable Unix socket but rejects route work before forwarding. Once migration and health checks succeed against an externally promoted primary, the same Router process becomes ready.
- Recovery never revives the old Session generation or retries an Action whose write outcome is unknown. A recovered Runtime may register the same boot instance only through the existing full reconciliation path and may create a new Session/PTY afterward.
- Runtime readiness requires the main durable transaction pool plus its admission and observation pools to reach a writable primary. A new PTY cannot become READY while a lazily used output/admission pool still points at the former primary.

## Consequences

- iTerminal can follow an externally authorized primary change without process restart when at least one configured endpoint reaches the new writable primary.
- Read-only standbys are availability candidates only after promotion; they cannot serve owner registry, fencing, routing, or observation reads because those reads must share one primary-authority contract with writes.
- Endpoint order is local discovery, not load balancing, consensus, health voting, or topology truth.
- A primary that remains reachable but loses synchronous quorum fails through statement deadlines. It is not bypassed until its connection fails or the external control plane fences it. This preserves the rule that only the database control plane decides promotion.
- Independent pools may observe different endpoint indices briefly. Safety comes from every admitted endpoint being a writable externally authorized primary, not from process-local index agreement.

## Migration and rollback

No schema migration is required. Existing single-URL deployments continue unchanged. Operators add `ITERM_DATABASE_URLS` only after configuring replication, primary fencing, promotion, and endpoint reachability outside iTerminal.

Rollback removes `ITERM_DATABASE_URLS`, restores one authoritative `ITERM_DATABASE_URL`, and deploys the older binary. Runtime and Router processes must be restarted because endpoint configuration is boot-scoped. Durable Sessions and registry rows require no data conversion.

## Verification boundary

M9.16 must prove with real PostgreSQL nodes and real Runtime/Router processes:

1. the initial primary has two streaming standbys and synchronous quorum policy;
2. baseline placement and zsh execution commit on the initial primary;
3. pausing both standbys leaves the old primary reachable but makes heartbeat/write progress fail within the configured deadline, fences the Runtime, and admits no new placement;
4. the old primary is stopped before a standby is promoted;
5. the same Router and Runtime processes rotate away from endpoint zero, reconcile the old generation to `BROKEN/UNKNOWN`, and create a new Session/PTY through the promoted primary while the old primary remains down;
6. the promoted timeline contains one durable baseline Session and no duplicate recovered generation or replayed Shell side effect.

This is local L2 evidence for one synchronous-replication minority and controlled promotion path. It is not automatic failover, distributed consensus implemented by iTerminal, cross-region proof, arbitrary split-brain prevention, zero-RPO under every `synchronous_commit` policy, correlated broker/database recovery, rolling database upgrade, remote process reclamation, long soak, or the M9 L4 exit gate.
