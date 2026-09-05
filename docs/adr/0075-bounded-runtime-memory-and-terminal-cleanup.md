# ADR-0075: Bound Runtime memory and release terminal execution resources

- Status: Accepted for review-remediation B07
- Date: 2026-09-05
- Refines: ADR-0039, ADR-0040, ADR-0053, ADR-0072, ADR-0074

## Context

The in-process Runtime keeps live Sessions and several projections in memory. `MemoryRuntimeStore`
previously retained every Action, Execution, idempotency binding, and Event for the lifetime of the
process. `RuntimeService` also retained settled Execute promises and dispatch objects. A Runtime
that served many short interactions therefore grew with historical work even when PostgreSQL had
already committed the authoritative terminal facts.

Eviction cannot be indiscriminate. An active, queued, or not-yet-persisted Action can still own a
side effect or a waiter. In durable mode ADR-0074 provides exact Action/Execution fallback and an
admission-time idempotency check. In memory-only mode no equivalent truth exists: forgetting a
current-generation idempotency key could repeat a PTY write. Event history has a different contract:
it is an observation projection and may discard a prefix only when the cursor gap is explicit.

## Decision

### Resource ownership and end conditions

The Runtime keeps the following resource classes:

| Collection/resource                                      | Owner and add point                       | End/delete condition                                                                                                                                         | Bound                                                                  |
| -------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Store Sessions                                           | `MemoryRuntimeStore.createSession`        | Failed unadmitted creation, or explicit owner teardown policy; a live Session is pinned                                                                      | active Session count                                                   |
| Store Actions/idempotency/Executions                     | Action admission after durable acceptance | Durable terminal fact enters FIFO history and linked Action/idempotency/Execution are evicted together; memory-only current-generation facts are not evicted | durable history entries + bytes; memory-only admission entries + bytes |
| Store Events                                             | `appendEvent` per Session generation      | Oldest contiguous prefix discarded incrementally                                                                                                             | entries + estimated bytes per generation                               |
| Executors/identity/screens                               | successful Shell launch                   | close, broken generation, startup failure, or owner shutdown                                                                                                 | live Session count                                                     |
| Execute `started`/`completion`/dispatch state            | Execute admission                         | shared completion settles, after waiter notification                                                                                                         | active Execute count                                                   |
| V2 waiters/timers/listeners                              | one nonzero wait                          | that waiter completes, times out, aborts, or registration fails                                                                                              | caller concurrency; every exit unregisters                             |
| Durable queues/output buffers                            | first durable mutation/output chunk       | queue becomes idle and Session closes/breaks; output flush or teardown clears timer                                                                          | live/pending Session count and existing backlog byte/count limits      |
| Mutation tails                                           | first concurrent mutation                 | final queued mutation releases                                                                                                                               | currently mutating Session count                                       |
| Interaction/input/sensitive/lease/checkpoint projections | Session launch or first relevant mutation | Session close/break where the value no longer controls a live PTY                                                                                            | live/rebuildable Session count                                         |
| Actors, approvals, approval/fork/create replay maps      | identity or workflow admission            | durable caches may be discarded only where their durable API remains authoritative; memory-only values remain safety facts                                   | not expanded into a new retention protocol by B07; reported separately |

B07 bounds the identified Action/Execution/Event history and settled Execute transients. The final
row remains visible in diagnostics so later work cannot mistake it for a completed retention policy.
Approval expiry/retention, root-Session idempotency retention, and checkpoint retention continue to
follow their existing contracts.

### Injectable defaults and incremental accounting

`RuntimeServiceOptions.retention` configures the in-process store when the store supports retention.
Defaults are:

- durable terminal history: 4,096 linked fact entries and 16 MiB estimated JSON bytes;
- memory-only Actions/idempotency facts: 4,096 entries and 16 MiB estimated JSON bytes;
- memory-only Control safety reserve: 64 entries and 256 KiB inside those maxima;
- Event history: 2,048 Events and 4 MiB estimated JSON bytes per Session generation.

The durable history entry is one Action plus its optional Execution. Memory-only admission counts
both Action and Execution estimates, including terminal output/cwd growth refreshed at settlement.
Its byte estimate is the UTF-8
size of canonical JSON for those in-memory objects; this is an accounting estimate, not V8 heap or
RSS truth. Event bytes use the same estimate. Defaults retain useful recent debugging context while
remaining small compared with the existing 8 MiB per-Session pending durable-output limit.

The store maintains counters, reverse idempotency bindings, and insertion-ordered terminal queues
as entries change. Pruning consumes only the oldest candidates needed to regain the budget. It does
not scan all Runtime history on every call. Limits are positive safe integers and tests inject small
values.

### Durable eviction and anti-replay

A terminal Action is eligible only after the Application operation that stores its terminal state
has succeeded. Execute eligibility additionally requires a terminal Execution. Active,
`DISPATCHING`, `RUNNING`, `ACCEPTED`, queued, or durability-uncertain facts never enter the eviction
queue. Eviction removes the linked Action, its in-memory idempotency binding, and optional Execution
atomically from the cache.

After eviction, a replay first misses memory and then crosses ADR-0074's durable replay gate before
sequence allocation or PTY side effects. Exact request hashes return the original durable Action;
changed requests conflict; active durable-only facts remain unavailable. PostgreSQL does not
recreate an executor, completion promise, Session, or READY Shell.

### Memory-only capacity and the Control escape path

Memory-only current-generation Action/idempotency facts cannot be forgotten safely. Ordinary new
Execute, Input, Secret Input, and Resize Actions are rejected with non-retryable `BACKPRESSURE` and
`component=runtime_memory_history` before sequence allocation or a PTY side effect when accepting
them would consume the Control reserve or exceed the ordinary byte budget. Existing queries, waits,
and Session close remain available.

Control Actions may consume the configured reserve up to the absolute memory-only maxima, so an
operator can interrupt or terminate the current foreground process after ordinary admission closes.
This is a finite safety lane, not an infinite exception: when the reserve itself is exhausted, new
Control also receives the same explicit capacity error and Session close remains available. A
future design that wants time-based forgetting must introduce an authenticated idempotency epoch;
B07 does not reinterpret an old key as new.

### Event prefix retention and cursor gap

Each memory Event stream keeps a FIFO retained suffix. On append, it removes only as much oldest
prefix as required by the configured entry and byte budgets. Discard clears the array slot before
advancing the floor, so diagnostics do not hide references to logically removed payloads. An Event
larger than the byte budget is discarded too; strict memory bounds win over retaining an anchor and
the resulting empty suffix reports the same explicit gap. The stream records `discardedThrough`
incrementally.

Memory-backed `EventPage` exposes retention metadata containing source `memory`,
`minimumAvailableSequence`, and whether a fresh read starts after a discarded prefix. A nonzero
`after` cursor before `discardedThrough` fails with `RESYNC_REQUIRED` and the same minimum.
It is never silently advanced. A fresh `after=0` read may return the retained suffix together with
`gap=true`; existing Event objects and `nextAfter` pagination remain unchanged. A nonzero cursor
equal to `discardedThrough` has explicitly acknowledged the removed prefix and may continue at the
minimum retained Event. Durable mode keeps
ADR-0053 as the database-authoritative cursor contract.

### Completion and close cleanup

One shared Execute completion continues to notify all registered V2 waiters. When it settles,
`started`, `completion`, and dispatch maps are removed after notification. Callers that already hold
the promises remain unaffected; later terminal waits read the terminal Execution snapshot. V2
waiters continue to own and clean their individual timer and Abort listener.

Close/broken teardown clears executor identity, screen, PTY output timer, sensitive live state,
lease, and idle durable queue state once no persistence work depends on them. It never signals the
PTY merely because an observer cancelled. Collection diagnostics report entry/byte counts; RSS is
observed separately and a heap that has not yet been garbage-collected is not called a leak.

## Consequences

- Durable owners retain a recent bounded cache while PostgreSQL remains the historical and
  anti-replay fallback.
- Memory-only owners fail closed at a configured history capacity instead of silently replaying or
  growing without bound.
- Event consumers can distinguish a retained suffix from a complete history.
- Terminal Execute promises and dispatch closures no longer live for the whole daemon lifetime.
- Very small test budgets may evict a fact immediately after its terminal commit; this is expected
  and exercises the same durable lookup path as long-lived owners.

## Not covered

- A finite public idempotency-key epoch or tombstone expiry.
- Durable Approval, root-Session creation, fork, checkpoint, or Actor retention policy.
- A hard V8 heap/RSS limit, garbage-collector scheduling, admission by resident-set size, or a
  production memory SLO.
- Database fact retention, Artifact retention, Event retention in PostgreSQL, or B06 tombstone
  capacity.
- Cross-owner cache coordination or restoring a PTY from durable history.

## Rejected alternatives

- **LRU every map indiscriminately:** can forget an in-flight side effect or reopen an idempotency
  key.
- **Treat terminal mutation as persisted:** a later durability failure would evict the only exact
  local fact before PostgreSQL became authoritative.
- **Silently start a stale Event cursor at the retained suffix:** makes missing output appear
  continuous.
- **Use timestamps or array indexes as Event cursors:** neither survives prefix deletion with exact
  ordering semantics.
- **Allow unlimited Control after capacity:** merely moves the unbounded memory path to another
  Action type.
- **Trigger garbage collection or declare RSS plateaus as proof of no leak:** GC timing and allocator
  behavior are not Application correctness contracts.
