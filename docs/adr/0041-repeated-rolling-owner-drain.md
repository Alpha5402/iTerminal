# ADR-0041: Preserve bounded creation progress across repeated owner drains

- Status: Accepted for M9.13
- Date: 2026-08-30
- Refines: ADR-0032, ADR-0033, ADR-0036, ADR-0040

## Context

M9.12 closes one exact race: a placement committed before an owner enters `DRAINING` can settle before that Runtime stops. A rolling deployment repeats this lifecycle while new root Sessions continue to arrive, replaces the stopped boot incarnation under the same stable owner ID, and later drains another owner. A single paused placement does not prove that registry epochs, placement exclusion, root-create idempotency, and healthy-owner progress continue to compose across several rounds.

Live PTYs still cannot migrate. A Runtime shutdown deliberately closes its Sessions, so "rolling drain succeeds" cannot mean that a long-lived shell survives replacement or that an Execution active at the shutdown deadline is replayed elsewhere. The measurable safety boundary is narrower: every accepted root-create identity binds at most one Session, no exact-owner intent is abandoned by an ordinary bounded drain, replacement advances only that stable owner's registry epoch, and at least one non-draining owner continues real work in every round.

## Decision

M9.13 exercises two complete drain/replacement cycles across three stable owner IDs while concurrent root creates continue through one stable Router:

1. start three independent Runtime owners and one independent Router;
2. begin a batch of uniquely keyed concurrent root creates;
3. send `SIGTERM` to one current owner while the batch is in flight;
4. require every create to settle, the drained incarnation to reach `STOPPED`, and its pending-intent count to reach zero;
5. execute a real zsh command on a Session assigned to a non-draining owner, then explicitly close remaining live Sessions from the batch;
6. start a boot-unique replacement on the same stable owner/socket and require the registry epoch to advance;
7. repeat for the other owners and then repeat the cycle once more.

The durable audit requires one request row and one distinct bound Session ID per submitted key, zero unfinished requests, terminal Sessions after explicit cleanup/drain, and all three final replacements ACTIVE at registry epoch 3. Placement counts are observed but not required to be equal while owners intentionally leave and rejoin.

The scenario accepts the existing lifecycle consequence that Sessions assigned to the draining owner end `CLOSED`. It does not issue a mutating Action against those Sessions after stop and does not convert route loss into retry on another owner. A command on a healthy owner proves service progress for that round without asserting live PTY failover.

## Consequences

- Repeated replacement preserves stable owner identity while boot instance and registry epoch advance independently.
- Root-create callers do not need to know which drain round raced their placement; the durable key still settles once.
- A rolling operator must expect shells on the drained owner to close. Work requiring continuity must use an explicit checkpoint/rebuild workflow, not hidden routing failover.
- The fixture bounds cardinality and duration so it remains deterministic in ordinary integration infrastructure.

## Verification boundary

M9.13 is repeated local-process L2 evidence. Six drain/replacement rounds with concurrent create batches are materially stronger than a single lifecycle check, but they are not a multi-hour soak, high-cardinality load test, CPU starvation experiment, process-manager deployment, remote-host reclamation, PostgreSQL minority/quorum test, or M9 L4 completion.

## Rejected alternatives

- **Require active PTYs to survive replacement:** impossible without moving kernel-owned process state and contradicts the generation model.
- **Retry failed exact-owner work on a healthy owner:** can create two PTYs after an uncertain original forward.
- **Assert equal placement during drain:** availability changes are deliberate; equal counts are not the safety invariant.
- **Reuse the stopped boot instance ID:** registration correctly rejects resurrection; every replacement needs a fresh incarnation identity.
- **Call six local rounds a long soak:** repetition catches lifecycle composition errors but does not establish duration, resource, or production orchestration claims.
