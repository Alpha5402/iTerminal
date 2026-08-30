# ADR-0040: Settle pre-drain placement before stopping a Runtime owner

- Status: Accepted for M9.12
- Date: 2026-08-30
- Refines: ADR-0030, ADR-0033, ADR-0036, ADR-0039

## Context

Graceful Runtime shutdown currently marks the owner `DRAINING` before closing its Sessions, but the daemon's local readiness flag becomes false as soon as `close()` is invoked. A Router may have committed a root-Session placement immediately before `DRAINING` acquired the owner row lock, then forward the exact durable intent after local readiness has already closed. The request cannot safely move to another owner, so immediate RPC rejection leaves a permanently unfinished intent until retention cleanup.

Stopping new placement and settling already committed placement are separate boundaries. PostgreSQL can identify the stable set: placement claims lock/update the owner row, so a successful transition to `DRAINING` waits behind earlier claims; later claims exclude that owner. Every unfinished `session_creation_requests` row for the exact owner incarnation visible after that transition was therefore committed before drain.

The RPC server also needs a distinction between immediate close and graceful drain. Destroying active sockets before their response is written turns a successfully bound Session into `DELIVERY_UNKNOWN` even when shutdown has time to finish cleanly.

## Decision

Durable Runtime shutdown follows this bounded order:

1. persist the exact owner as `DRAINING` and renew its Session leases;
2. keep RPC admission available for a configurable settlement grace (default 5 seconds);
3. poll the database-authoritative count of unfinished creation intents for that exact owner incarnation;
4. when the count reaches zero, stop accepting new Unix connections and allow already accepted RPC sockets to finish and write responses within the remaining deadline;
5. after settlement or deadline, close live Sessions, stop supervision, and persist `STOPPED`.

The RPC package exposes a bounded graceful-drain primitive in addition to immediate `close()`. Graceful drain stops listening without destroying active sockets, waits for the server's connections to close naturally, and force-destroys remaining sockets at the deadline. Immediate close retains its existing cancellation behavior for crashes, startup failure, and components that do not promise drain.

`ITERM_RUNTIME_DRAIN_TIMEOUT_MS` configures the shared settlement/RPC deadline. Diagnostic drain states report `DRAINING`, `SETTLED`, or `TIMED_OUT` with the pending intent count. Diagnostic callback failures do not change lifecycle behavior.

The grace period does not reassign an intent and does not extend indefinitely. If a Router crashed after claim or a request remains stuck, timeout preserves the existing exact-owner truth: shutdown continues, the intent remains unfinished, and later retry returns `OWNER_ROUTE_UNAVAILABLE` until retention makes it eligible. Existing Session routes may continue during the bounded DRAINING interval. Direct owner-socket access remains trusted-local and must not be exposed as a public creation endpoint.

## Consequences

- A placement committed before `DRAINING` can still bind one Session and return its response.
- New Router placement excludes the owner as soon as the drain transaction commits.
- Shutdown has one explicit time budget rather than an unbounded wait for a lost Router.
- Long-running existing RPC work may be force-cancelled at the deadline and retains its normal uncertainty contract.
- `SIGKILL`, database-unavailable shutdown, and remote host loss remain conservative broken-generation paths, not graceful drain.
- This closes the pre-forward drain race but is not sustained rolling-upgrade or long-soak proof.

## Verification boundary

M9.12 pauses an independent Router after its durable placement claim and before owner forwarding, sends `SIGTERM` to the selected Runtime, observes exact-owner `DRAINING` with one pending intent, and proves that the Runtime stays alive. Releasing the Router creates and returns the Session, drains the response, closes the Session, and persists `STOPPED`; a healthy owner concurrently accepts and executes real zsh work. This is L2 process/PostgreSQL/PTTY evidence, not repeated rolling upgrades, timeout-path load testing, process-manager integration, CPU starvation, or M9 L4.

## Rejected alternatives

- **Move the pending intent to another owner:** violates exact-owner idempotency and can create two PTYs after an uncertain forward.
- **Close RPC immediately after writing `DRAINING`:** preserves the existing committed-placement race.
- **Wait only for active sockets:** the Router may not have connected yet even though its placement intent is durable.
- **Wait forever for pending intents:** a crashed Router would prevent shutdown indefinitely.
- **Treat a socket response as the durable boundary:** Session binding remains PostgreSQL truth; socket completion only improves graceful client settlement.
