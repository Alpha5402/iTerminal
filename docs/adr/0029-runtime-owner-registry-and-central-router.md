# ADR-0029: Runtime owner registry and central Unix Router

- Status: Accepted for M9.1
- Date: 2026-08-30
- Refines: ADR-0007, ADR-0010, ADR-0015

## Context

The M8 Execution Worker is configured with one Runtime owner ID and one Unix socket. It correctly rejects messages for another owner, but no shared source tells a Human Console, MCP adapter, or Worker which process currently holds a Session's PTY. Starting multiple consumers without that routing fact would either strand Actions or tempt a non-owner to create a second PTY for the same generation.

An owner ID alone is insufficient. It is intentionally stable across one logical Runtime route, while operating-system processes restart. A stale process and its replacement can therefore present the same owner ID. PostgreSQL needs a boot-specific identity and a monotonic epoch before later Session leases and fencing can distinguish them.

## Decision

### Owner and instance identity

- `ownerId` is the stable logical routing identity already stored on Session generations.
- `instanceId` is a random, boot-unique Runtime daemon incarnation and is never reused intentionally.
- `registryEpoch` is a PostgreSQL-allocated monotonic number for successive instances under one owner ID.
- `endpoint` is the daemon's absolute local Unix socket path. M9 remains local-first; the registry does not make an endpoint remotely authenticated.

The worker registry stores one current row per owner ID with instance ID, epoch, endpoint, lifecycle status, heartbeat time, lease expiry, start/stop timestamps, and a version. `ACTIVE`, `DRAINING`, and `STOPPED` are persisted states. Expiry is derived from database time; it is not a heartbeat-written `EXPIRED` state.

### Register, heartbeat, drain, and stop

Registration serializes on the owner row:

- a missing owner registers at epoch 1;
- the same exact instance may idempotently refresh its endpoint/lease without changing epoch;
- a different instance is rejected while the current `ACTIVE` or `DRAINING` lease is unexpired;
- after expiry or explicit `STOPPED`, a different instance replaces the row and increments the epoch.

Heartbeat, drain, and stop require the exact `(ownerId, instanceId, registryEpoch)` tuple. A stale instance gets `OWNER_LEASE_LOST`; it cannot overwrite the replacement's row. Heartbeat extends the lease using PostgreSQL time. Drain keeps the lease alive but removes the owner from new-Session placement. Existing Sessions may continue routing to a live draining owner while it closes them. Graceful shutdown persists `STOPPED`; crash relies on lease expiry.

The daemon registers before it performs owner recovery. This ordering prevents a second live process with the same owner ID from breaking or claiming the first process's durable Sessions. A failed heartbeat is an owner-wide durability failure: the daemon closes its PTYs and admits no more writes before attempting registry recovery.

### Central Router selection

M9 selects a central local Unix Router rather than owner-specific public queues or a per-Session supervisor process:

```text
Human Console / MCP / Execution Worker
                  |
          stable Router Unix RPC
                  |
       PostgreSQL owner registry + Session owner
                  |
        exact Runtime owner Unix RPC
                  |
               PTY/Shell
```

The Router will remain an adapter with no Session state machine or PTY. New Session placement considers only unexpired `ACTIVE` owners and excludes `DRAINING`. Existing exact-Session operations resolve the durable Session owner and require an unexpired `ACTIVE` or `DRAINING` registry row. Missing, stopped, expired, or conflicting routes fail closed; the Router never creates a replacement PTY under an old Session generation.

M9.1 implements the registry and daemon lifecycle foundation. Router forwarding, generation-scoped Session leases, and write fencing are subsequent M9 slices and may not be claimed from registry epoch alone.

### Registry epoch versus Session fencing

Registry epoch fences writes to the owner registry row only. It does not authorize a Session mutation and cannot undo bytes already written to a PTY. Every live generation will later acquire a separate monotonic Session fencing token, and every durable Action/Execution/interaction/resize/lifecycle mutation must verify owner, instance, generation, and that token in the same transaction.

## Consequences

- PostgreSQL becomes the discoverable routing fact for live Runtime owner incarnations without becoming live PTY truth.
- Two processes cannot simultaneously register one stable owner ID while its current lease is live.
- Drain is explicit and distinguishable from crash expiry.
- Heartbeat loss conservatively destroys local live state instead of continuing unfenced.
- Router availability depends on PostgreSQL and local Unix endpoint reachability; there is no transparent PTY failover.
- Boot-unique instance IDs and registry epochs provide the prerequisite for stale-owner diagnostics and later Session fencing.

## Rejected alternatives

- **Use only stable owner ID:** cannot distinguish concurrent or restarted processes.
- **Let RabbitMQ choose any Worker:** message consumption does not prove access to the owning PTY and would violate owner-local dispatch.
- **One public queue per owner as the only Router:** does not route synchronous MCP/HTTP screen, input, control, and lifecycle operations and leaves queue cleanup/service discovery unresolved.
- **Create a replacement PTY when an endpoint is absent:** falsely revives an old generation and can duplicate side effects.
- **Treat registry epoch as Session fencing:** protects the wrong row and leaves stale durable Session/Execution writes possible.
- **Per-Session supervisor process now:** could simplify later ownership, but would replace the proven Runtime/PTY lifecycle before multi-owner routing facts exist.
- **Remote HTTP endpoints in the registry:** exceeds the local authentication and transport boundary; M10 owns remote security.
