# ADR-0038: Keep the Router alive through PostgreSQL cold-start failure

- Status: Accepted for M9.10
- Date: 2026-08-30
- Refines: ADR-0030, ADR-0037

## Context

ADR-0037 proves that a running Router fails closed and recovers after its PostgreSQL path is restored. The production Router entrypoint still performed migration before binding its Unix socket, so starting while PostgreSQL was unavailable terminated the process. An external process manager could restart it, but that makes recovery policy implicit and prevents clients from receiving the same structured degraded-state contract used for a live outage.

The Router cannot become route-ready before migrations and a database round trip succeed. It may, however, bind its local RPC socket while degraded as long as every operation is gated before route lookup or owner forwarding.

## Decision

The production Router starts a database recovery supervisor and binds its Unix RPC socket independently. The database gate begins in `CONNECTING`; while it is not `READY`, every routed operation returns retryable `RUNTIME_UNAVAILABLE` with the existing `runtime-router`/`route_resolution` details plus bounded database phase, attempt, and retry delay metadata.

The supervisor retries idempotent schema migration with bounded exponential backoff and jitter. After success it enters `READY` and performs periodic `SELECT 1` health checks. A raw route-query failure moves the gate back to `UNAVAILABLE`; subsequent calls fail fast while the supervisor re-enters migration/connection recovery. State reports never expose raw connection strings or database errors.

The CLI entrypoint enables supervision by default and accepts the same health/reconnect environment variables as Runtime database supervision. Programmatic `startRuntimeRouter` callers remain fail-fast unless they explicitly enable supervision, preserving deterministic embedded tests and deployments.

Shutdown first closes RPC admission, then stops the supervisor, then closes the route pool. A blackholed query remains bounded by the configured database statement timeout.

## Consequences

- The Router process and socket can exist before PostgreSQL readiness without serving stale routes.
- Clients receive a stable degraded response instead of connection refusal or process churn.
- Healthy Routers and owners continue independently while a cold Router retries.
- Migration remains the readiness proof; no separate local state is authoritative.
- Repeated state logs and retry traffic are bounded but still require production observability and deployment-level readiness integration in M10.

## Verification boundary

M9.10 starts one Router while its only PostgreSQL path silently discards bytes, alongside a healthy Router and two Runtime owners. It proves degraded RPC, bounded retry, no root-creation side effect, healthy-path progress, same-process transition to READY after stale-stream reset, and real zsh execution after recovery. It is L2 evidence, not PostgreSQL minority/quorum, Kubernetes readiness, or the M9 L4 gate.

## Rejected alternatives

- **Exit and rely only on process-manager restart:** hides recovery semantics and creates avoidable socket churn.
- **Listen and query without a readiness gate:** allows every request to occupy a connection until timeout during cold start.
- **Declare READY before migration:** can route against missing or stale schema.
- **Cache routes during startup:** violates ADR-0037 freshness and owner-incarnation guarantees.
- **Return connection refusal as the contract:** loses structured retry metadata and cannot distinguish Router death from database degradation.
