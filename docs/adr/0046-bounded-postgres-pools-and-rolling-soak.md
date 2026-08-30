# ADR-0046: Bounded PostgreSQL pools and scaled rolling-soak gate

- Status: Accepted for M9.18
- Date: 2026-08-30
- Refines: ADR-0032, ADR-0041, ADR-0045

## Context

M9.13 proves six drain/replacement rounds across three Runtime owners and 48 root Sessions. That is enough to expose lifecycle ordering defects, but not topology/cardinality limits or accumulation across sustained churn. The first M9.18 eight-owner attempt found a concrete scaling failure before the rolling assertions could complete: each durable Runtime independently constructed durability, admission, observation, and owner-registry PostgreSQL pools. Their historical defaults had a theoretical aggregate of 55 connections per Runtime, and PostgreSQL 17 reached its default 100-client limit during concurrent root creation.

Increasing PostgreSQL `max_connections` would hide the composition error and move resource exhaustion to a larger deployment. A Runtime needs an explicit database connection budget whose bound can be calculated before deployment. A soak also needs fixed invariants and machine-readable measurements; merely repeating a test for an arbitrary time is not evidence.

## Decision

### Per-role connection budget

- `PostgresRuntimeDurability`, `PostgresRuntimeRepository`, `PostgresObservationRepository`, and `PostgresRuntimeOwnerRegistry` accept a positive `poolMax` while retaining their existing library-level defaults for direct callers.
- A production durable Runtime uses `ITERM_DATABASE_POOL_MAX`, default 2, for each of its four logical pools. With one configured PostgreSQL endpoint, one Runtime can therefore hold at most eight database connections. Multiple ordered endpoints have an independent pool per endpoint; operators must budget the short overlap while an old endpoint's idle connections expire after failover.
- Pool bounds limit concurrency; they do not weaken transaction, fencing, timeout, or fail-closed semantics. Saturation waits on the bounded local pool and remains subject to existing query/statement/connect deadlines.
- The host-local Process Guardian is not a database client and consumes none of this budget.

### Three explicit rolling profiles

- `smoke`: six independent Runtime/Guardian pairs, six rotations, 18 concurrent creates per rotation. This is the ordinary PostgreSQL CI regression and is not a soak claim.
- `high`: eight independent Runtime/Guardian pairs, 16 rotations, 32 concurrent creates per rotation, plus warm-up and final fairness reconciliation. This must settle at least 528 unique root Sessions and execute real zsh on every initial owner and one healthy owner per rotation.
- `soak`: eight independent Runtime/Guardian pairs by default, continuous 32-Session rolling waves for at least 30 minutes and at least 16 rotations. Duration, owner count, wave size, and minimum rotations are bounded environment overrides for operator runs; reducing them changes the evidence scope and cannot be reported as the default soak gate.

Every profile uses one independent Router process, real Unix RPC, PostgreSQL, node-pty/zsh, and one independent Guardian per Runtime. Each rotation begins concurrent root creation, drains one owner, waits for exact-owner intents and accepted responses to settle, proves healthy-owner Shell progress, closes every Session, verifies released leases and zero unfinished requests, replaces the same stable owner at the next registry epoch, and checks all other Runtime/Guardian processes remain alive.

The scaled fixture uses a five-second PostgreSQL statement deadline. A retryable route-database failure or `DELIVERY_UNKNOWN` during root creation is retried for at most 30 seconds with the exact same global idempotency key and payload. This models the documented settlement contract: it may discover the first Session binding, but it cannot claim a different owner or create a second PTY. Execute/Input/Control are never generically replayed by this gate.

### End-state and resource assertions

- Every idempotency identity binds one distinct Session; no request remains unbound and no live Session or unreleased Session lease remains after a wave.
- Historical equal-weight placement debt is reconciled after all owners return ACTIVE; final placement counts must be exactly equal.
- Every drained Guardian PID must disappear before replacement. Final graceful shutdown must leave every owner `STOPPED` and every Guardian gone.
- The test samples PostgreSQL client connections throughout create waves. The bound is `ownerCount * 10 + 10`, covering four Runtime pools at two connections each plus Router/test overhead without approaching the old 55-per-Runtime composition.
- Runtime plus Guardian RSS is sampled after warm-up, per rotation, and at the end. Final RSS may grow by at most 64 MiB per active owner over baseline and the observed peak by at most 128 MiB per owner. These are regression thresholds, not production capacity recommendations.
- The test emits one `M9_ROLLING_RESULT` JSON line containing profile, topology, rotations, Sessions, elapsed time, P95 create/rotation latency, PostgreSQL connection peak, and baseline/peak/final RSS.

## Consequences

- High owner counts no longer multiply uncoordinated pool defaults until PostgreSQL refuses clients.
- A lower pool limit can increase queueing latency under burst load. Operators may raise it only with a corresponding database-wide budget: `runtime_count * endpoint_count * 4 * pool_max`, plus Router, relay, worker, console, migration, monitoring, and administrative reserve.
- The high and soak profiles intentionally retain durable request/session history for the run, so they exercise table/index growth as well as process churn. The fixture raises only the test policy's request-cardinality limit; it does not bypass fencing, idempotency, or retention logic.
- A successful local soak does not prove multi-host network behavior, database/broker correlated failure, cross-platform parity, production workload shape, or weeks of dogfood. Those remain M8/M10 gates.

## Verification boundary

M9.18 closes only when the smoke and high profiles pass and one unshortened default 30-minute soak result is recorded. The report must preserve the initial 100-client failure as evidence for the connection-budget change and must quote the final JSON metrics. A skipped test, a shortened debug run, static type checking, or a green ordinary `pnpm verify` cannot substitute for that result.
