# ADR-0031: Generation-scoped Session lease and durable-write fencing

- Status: Accepted for M9.3
- Date: 2026-08-30
- Refines: ADR-0008, ADR-0010, ADR-0015, ADR-0029, ADR-0030

## Context

The M9.1 owner registry answers which daemon incarnation is currently routable, and M9.2 sends a request to that endpoint. Neither fact authorizes a database mutation for one Session generation. A daemon can pass route lookup, lose its owner lease, and still hold a PostgreSQL connection or an old PTY. Stable `owner_id` and registry epoch alone therefore do not prevent stale Action, Execution, Event, checkpoint, interaction, resize, or lifecycle writes.

Fencing also cannot undo bytes already delivered to a PTY or an external command. The useful linearization point is the last database transaction before a PTY write and every transaction that commits the resulting state.

## Decision

### Separate owner identity, Session fence, and optimistic version

Three different facts remain explicit:

- `(owner_id, instance_id, registry_epoch)` identifies the currently registered daemon incarnation.
- `(session_id, generation, fencing_token)` authorizes one generation's durable mutations.
- Execution `version` is an optimistic expected-version check for one state transition.

They are not interchangeable. `session_fencing_token_seq` allocates positive, globally monotonic tokens. `session_leases` records the exact owner incarnation, database-time acquisition/renewal/expiry, release reason, and version for each Session generation.

### Acquisition and renewal

Creating a root or forked child Session inserts its generation and Session lease in the same transaction. Acquisition requires the exact Runtime owner row to be unexpired and `ACTIVE` or `DRAINING`; Router placement still restricts new root Sessions to `ACTIVE` before this transaction. A fork may read a historical `BROKEN` parent without a parent lease, but the child acquisition and parent audit mutation require the current registered owner incarnation. A live parent additionally requires its exact Session fence.

The daemon renews exact locally held fences after its owner heartbeat. Renewal locks and validates the current owner row, renews only the supplied `(session, generation, token)` set, and caps Session expiry at the owner lease expiry. Missing, released, replaced, expired, or partial renewal returns `SESSION_LEASE_LOST` and trips the owner-wide Runtime circuit; local PTYs/process groups are then closed best-effort.

Owner recovery is a privileged transition, not a stale Session write. It requires the exact current owner incarnation, marks the previous owner's live generations `BROKEN`, makes active Executions `UNKNOWN`, releases their Session leases, and only then exposes bounded historical rebuild projections. A replacement never acquires or recreates an old generation's PTY.

### Transaction guard

Every live-generation mutation first locks both the exact `session_leases` row and matching `runtime_workers` row in the same PostgreSQL transaction. The guard requires:

- matching Session ID, generation, owner ID, instance ID, registry epoch, and fencing token;
- unreleased Session lease with `lease_expires_at > now()`;
- matching Runtime owner incarnation in `ACTIVE` or `DRAINING` with `lease_expires_at > now()`.

The lock serializes a valid mutation against owner replacement, lease renewal/release, and recovery. If the mutation locks first it may commit before takeover; if takeover/release linearizes first, the stale mutation receives non-retryable `SESSION_LEASE_LOST`. There is no stale route or lease cache fallback.

Covered writes include Session ready/broken/close, Execute admission/write-attempt/running/terminal state, Action state, Input/Control, Resize, Interaction policy/Guard, Events, PTY output/artifacts/screen version, snapshots, checkpoints, and live-parent fork audit. Execution transitions additionally compare the expected durable `version` before incrementing it.

### PTY uncertainty boundary

Execute, Input, Control, and Resize persist a fenced write-attempt before touching the PTY. Lease loss after that commit but before the syscall remains an unavoidable external-effect race. The old process may have acted, so the system never retries the mutation automatically or claims exactly-once effects. Heartbeat/renewal failure closes the local executor and process group best-effort; any later durable write is fenced out.

### Lifecycle release

Graceful close and durable `BROKEN` transitions release the Session lease in the same transaction. Graceful daemon shutdown drains routing, closes each live Session through its fence, then stops the owner. Crash leaves leases to expire; replacement recovery releases them while marking old generations broken.

Concurrent daemon startup serializes schema migration with a database advisory lock and skips versions already present in `schema_migrations`. Recovery must not race an unrelated startup that replays historical table-altering DDL.

## Consequences

- A route to a live endpoint is no longer sufficient to mutate a Session.
- A stale daemon cannot commit output or terminal state after replacement/recovery linearizes.
- Session lease expiry is based on PostgreSQL time and cannot outlive its owner lease.
- Expected Execution versions reject same-fence state races independently of ownership.
- Every live durable method must receive an explicit `SessionFence`; omitting it is a compile-time interface error.
- Reads remain unfenced, but Router route resolution still fails closed for unavailable owners.
- The design deliberately does not provide live PTY migration or exactly-once Shell effects.

## Rejected alternatives

- **Use registry epoch as the fencing token:** protects only the owner row and cannot distinguish Session-generation authority.
- **Check the lease in a separate query or heartbeat:** leaves a check-to-commit race.
- **Cache a validated fence in the Router:** route freshness is not transaction authorization.
- **Renew every database lease owned by an instance:** can keep an orphaned PTY authority alive after local state loss; renewal must name the exact local fence set.
- **Acquire an expired old generation on another daemon:** would create a second semantic PTY for one generation; recovery instead marks it broken and rebuilds a new Session.
- **Retry after `SESSION_LEASE_LOST`:** a PTY write may already have occurred, so retry can duplicate external effects.
