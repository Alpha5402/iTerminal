# ADR-0002: Structured Actions, Execution facts, and fail-fast Busy

- Status: Accepted for M0
- Date: 2026-08-30

## Context

Transport success does not prove that a terminal operation ran. Concurrent Human/Agent writes can corrupt a Shell line or target a different foreground program than the one originally observed.

## Decision

Every write is an immutable `ExecuteAction`, `InputAction`, or `ControlAction`.

- Execute is accepted only by a `READY -> RESERVED` compare-and-set. A competitor gets `PTY_BUSY`; there is no unbounded per-Session execute queue.
- Input and Control target an exact Session generation and active Execution.
- Action acceptance, PTY delivery, Shell-observed start/end, and final outcome remain distinct facts.
- A write whose delivery is uncertain becomes `UNKNOWN` and is not replayed automatically.

## Consequences

- Clients must handle Busy through wait, interaction/control, or Session fork.
- The database model requires Action and Execution records rather than one overloaded command row.
- Idempotency keys return the original Action only when the request hash also matches.
- User interfaces cannot write directly to a READY Shell; they submit an ExecuteAction through the same Application service.
