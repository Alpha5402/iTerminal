# ADR-0034: Asymmetric Runtime-owner database partition

- Status: Accepted for M9.6
- Date: 2026-08-30
- Refines: ADR-0015, ADR-0017, ADR-0031, ADR-0033

## Context

M8 proves owner-wide PostgreSQL circuit breaking, while M9.5 proves independent owner-process replacement. Neither proves that one partitioned owner fails closed while the Router and other owners continue serving.

## Decision

One Runtime may reach PostgreSQL through a different network path. If that path silently drops bytes, statement deadlines trip only that owner's durability circuit: it closes local PTYs, rejects admission, stops heartbeat renewal, and eventually disappears from Router placement. Healthy owners and the Router continue through direct database paths.

Restoration must establish clean TCP connections. Timed-out PostgreSQL protocol streams are reset before forwarding resumes; they are not assumed reusable. Every Pool installs error listeners on both the Pool and each connected Client. Query Promises still reject and drive supervision, but a late checked-out Client error cannot terminate the Runtime through an unhandled EventEmitter error.

The surviving process may re-register the same boot incarnation after lease expiry without advancing registry epoch. Recovery still marks old generations `BROKEN`, ambiguous Executions `UNKNOWN`, and releases old Session leases. Continued work requires a new Session/PTY.

## Consequences

- Failure isolation follows database reachability, not host/process boundaries.
- Healthy owners continue exact routing and receive new placement while the victim is expired.
- TCP reset is part of recovery from an unknown PostgreSQL stream state.
- Same-process recovery does not imply old-generation recovery.

## Verification boundary

M9.6 uses one Router, three independent Runtime processes, one per-owner TCP blackhole, real PostgreSQL, and real zsh PTYs. It is L2 evidence, not the M9 L4 gate: minority database partitions, Router partition, CPU starvation, repeated flapping, sustained load, and remote process reclamation remain open.

## Rejected alternatives

- **Keep using a timed-out PostgreSQL stream:** protocol synchronization is no longer trustworthy.
- **Crash the Runtime on late Client error:** turns a recoverable transport failure into uncontrolled process loss.
- **Continue serving from memory:** would admit unfenced writes and split durable truth.
- **Move victim Sessions to healthy owners:** would violate the no-live-PTY-failover contract.
