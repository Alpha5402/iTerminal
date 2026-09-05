# ADR-0067: Execution lifetime and fatal settlement

- Status: Accepted
- Date: 2026-09-05
- Refines: ADR-0001, ADR-0002, ADR-0003, ADR-0011, ADR-0020, ADR-0040, ADR-0045

## Context

`PtyShellExecutor` previously rejected a pending Execute after 24 hours. That adapter timeout did
not represent a user deadline, a Shell result, or an observation timeout. Rejecting only the
Application promise could leave the foreground process and persistent Shell alive after the
Application had made the generation `BROKEN`, creating an unreachable execution surface.

Startup handshakes, bounded observation requests, PTY Event flushing, and Runtime shutdown/drain
have separate safety or resource semantics. Removing an implicit execution lifetime must not
remove or widen those timers.

An adapter failure also needs to preserve the existing distinction between a command that was
definitely not written, a write with no observed completion, and a real Shell Integration
completion. Treating every adapter exception as `FAILED` would turn an uncertain Shell side effect
into a false negative.

## Decision

An Execute has no adapter-owned wall-clock lifetime. It remains active until Shell Integration
observes completion, an explicit Input/Control action changes it, the Session is explicitly closed,
or the current generation loses its Executor/Shell authority. This decision does not introduce a
user-configurable deadline.

The executor reports a local `onWriteAccepted` boundary after its first dispatch write returns.
This is evidence that the adapter accepted the write, not proof that the Shell consumed the bytes
or started the command. The durable `execution.write_attempted` fact still precedes the adapter
call and remains a conservative intent boundary for process-crash recovery.

Application settles an Execute fatal path with this matrix:

| Last trustworthy boundary                   | Execution / Action                                | Session  | Executor            | Meaning                                                                                |
| ------------------------------------------- | ------------------------------------------------- | -------- | ------------------- | -------------------------------------------------------------------------------------- |
| Dispatch write not accepted                 | `FAILED`                                          | `BROKEN` | Detached and closed | The adapter rejected before accepting the Shell dispatch write.                        |
| Dispatch write accepted, no real completion | `UNKNOWN`                                         | `BROKEN` | Detached and closed | The Shell effect may have occurred; no replay and no fabricated exit code.             |
| Real RESULT/READY completion observed       | `COMPLETED` or `INTERRUPTED` with observed result | `READY`  | Kept live           | The actual Shell Integration completion wins over a generic adapter failure assertion. |

An observed PREEXEC also proves the dispatch crossed the write boundary, so a `RUNNING` failure is
always `UNKNOWN` even if an older or test Executor does not implement the optional callback.

Once Application declares the current generation unwritable, it synchronously removes the exact
Executor identity, closes that Executor, clears pending output state, disposes the screen, and
settles local waiters before awaiting durable persistence. A lifecycle callback caused by that
close is stale by identity and cannot produce a second transition. The existing host-local
Guardian remains the independent backstop for a Runtime process that cannot perform this cleanup.

Startup continues to use its bounded Shell HELLO/READY timer. Screen observation timeout returns an
observation result and never cancels the Execution. Runtime drain continues to use its bounded
placement/RPC settlement deadline. Tests inject only the startup scheduler owned by the PTY
executor; production does not replace global timers.

## Consequences

- Long-running and interactive commands can outlive 24 hours without an implicit adapter failure.
- Callers use bounded observation requests when they need a bounded wait; they use explicit
  Control when they intend to interrupt a running program.
- A definite pre-write adapter failure remains distinguishable from uncertain delivery.
- Breaking a generation cannot leave its live Shell available without an Application control
  path in the same Runtime process.
- There is still no exactly-once Shell-effect claim. Host loss, kernel failure, or a dead Guardian
  retains ADR-0045's external fencing boundary.

## Rejected alternatives

- **Convert the 24-hour timeout into an exit code:** no process completion was observed.
- **Mark every executor rejection `FAILED`:** writes accepted before failure may have caused
  irreversible effects.
- **Keep the Shell for later attachment:** a broken generation cannot regain its old PTY authority.
- **Add a user deadline in this change:** cancellation policy and escalation semantics require a
  separate product contract.
- **Remove every timeout:** startup, observation, flushing, and drain timers have independent
  bounded-resource meanings.
