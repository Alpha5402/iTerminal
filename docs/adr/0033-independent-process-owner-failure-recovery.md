# ADR-0033: Independent-process Router and Runtime owner failure recovery

- Status: Accepted for M9.5
- Date: 2026-08-30
- Refines: ADR-0028, ADR-0029, ADR-0030, ADR-0031, ADR-0032

## Context

M9.1–M9.4 prove owner identity, central routing, generation fencing, fair placement, and durable admission, but their combined three-owner placement fixture runs several Runtime instances inside one test process. Earlier M4/M8 tests kill individual Runtime or Worker child processes, yet they do not exercise one stable Router with three independently supervised PTY owners.

The remaining question is not whether a dead PTY can move—it cannot—but whether independent process loss preserves that boundary while routing and placement recover around it.

## Decision

### Router restart

The local Router remains stateless. Its Unix socket and PostgreSQL connections are disposable process state; durable owner routes, placement counters, Sessions, Executions, and leases remain in PostgreSQL. Killing and restarting the Router creates no Runtime owner row and cannot create, recover, or mutate a PTY by itself.

Clients reconnect to the stable Router socket. A request interrupted across the crash retains the existing read/mutation ambiguity contracts; M9.5 does not add automatic retry.

### Runtime owner crash and replacement

An operating-system `SIGKILL` ends one exact `(ownerId, instanceId, registryEpoch)` incarnation without drain or lease release. Until its database-time owner lease expires, the Router fails closed for that owner's exact targets and a replacement boot incarnation cannot register.

After expiry, a boot-unique replacement under the same stable owner ID advances the registry epoch, reconciles all prior live generations to `BROKEN`, marks ambiguous Executions `UNKNOWN`, releases their Session leases, and hydrates only bounded historical `BROKEN` Session projections. It does not recreate old Execution objects or attach a new PTY to an old generation.

New work on that stable owner requires a newly placed Session with a new Session ID and a new generation-1 PTY. The stable owner's monotonic placement counter is retained across the replacement.

### Graceful owner shutdown

`SIGTERM` follows the existing daemon close path:

1. register `DRAINING` while the heartbeat remains valid;
2. renew exact local Session leases for shutdown;
3. stop RPC admission;
4. close local live Sessions and release their leases;
5. persist owner `STOPPED`.

Once stopped, the owner is not claimable and its old targets do not route to another owner. Other ACTIVE owners continue receiving placement claims.

### Process and persistence assertions

The M9.5 fixture uses one independent Router child, three independent Runtime children, real zsh PTYs, and real PostgreSQL. It verifies:

- concurrent 12-Session placement is 4/4/4;
- Router `SIGKILL` and restart preserve exact Session routing;
- Runtime `SIGKILL` removes the observed local Shell process;
- same-owner replacement advances registry epoch without taking over the old generation;
- old Session/Execution state becomes `BROKEN`/`UNKNOWN`, and old Execution RPC is not faked;
- one newly placed replacement Session executes successfully;
- graceful `SIGTERM` reaches `STOPPED`, and later placement excludes that owner;
- replacement live Sessions have exactly one unreleased Session lease while the victim lease is released.

## Consequences

- Process isolation is now covered by one composed three-owner scenario rather than inferred from separate unit/integration fixtures.
- Stable owner identity means placement continuity, not PTY continuity.
- Durable historical Execution facts remain queryable in PostgreSQL/Event history, but a replacement daemon does not expose a pretend live Execution object.
- A short unavailability interval during owner lease expiry is intentional fencing, not failover latency to optimize away.
- Router restart and Runtime replacement remain separate recovery operations.

## Verification boundary

M9.5 is L2 process-chaos evidence, not the full M9 L4 Exit Gate. It does not kill the Router during an in-flight mutating forward or placement transaction, inject an asymmetric/minority network partition, saturate PostgreSQL, delay heartbeats through CPU starvation, prove remote process reclamation after host loss, or run sustained rolling drain/long soak.

## Rejected alternatives

- **Immediately reuse an expired owner's old Session lease:** violates generation fencing and could create two PTYs for one generation.
- **Hydrate old Executions as live objects:** would misrepresent durable `UNKNOWN` history as process-local state.
- **Let the Router create a replacement PTY when forwarding fails:** turns route failure into unsafe hidden failover.
- **Reset placement count on owner replacement:** makes a boot restart attract a burst and conflates process incarnation with stable scheduling identity.
- **Treat `SIGKILL` and `SIGTERM` as the same lifecycle:** discards the only safe opportunity to drain, close Sessions, and release leases gracefully.
