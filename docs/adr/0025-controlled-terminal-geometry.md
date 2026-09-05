# ADR-0025: Runtime-owned controlled terminal geometry

- Status: Accepted for M6.6
- Date: 2026-08-30

Console initiation is amended by [ADR-0061](./0061-active-human-window-terminal-fit.md): an
explicitly activated foreground Human window may request responsive fitting through the same
ResizeAction boundary. The no-automatic-fit statements below describe the original M6.6 behavior.

## Context

The live Runtime and Virtual Screen currently start at a fixed 120×40 geometry. That avoids viewer races, but it prevents a Human or Agent from deliberately resizing a TUI and verifying the resulting `SIGWINCH`/reflow behavior. Letting every browser call `fit()` and write directly to node-pty would make the last connected viewer an implicit terminal owner, bypass Actions, and let a transient layout change silently alter every other participant's screen.

Resize is also a fallible PTY side effect. An accepted request is not proof that both the kernel PTY and the Runtime-owned headless projection converged. A retry after a lost response could apply a second resize unless it follows the existing idempotency and unknown-delivery rules.

## Decision

### Canonical owner and state

One Session generation has one canonical terminal geometry owned by its Runtime owner. Viewers never own geometry and never resize automatically on connect, reconnect, browser layout, or focus changes.

The default remains 120 columns × 40 rows. Controlled geometry is bounded to 40–240 columns and 12–100 rows. Every live screen frame exposes a `geometryVersion` starting at 1. A successful resize increments both `geometryVersion` and `screenVersion`; screen-version waits therefore observe resize/reflow as a visible change.

### ResizeAction

Resize is a fourth immutable Session Action:

```ts
interface ResizeAction {
  type: "resize";
  columns: number;
  rows: number;
  expectedGeometryVersion: number;
  status: "ACCEPTED" | "DELIVERED" | "UNKNOWN";
}
```

The request carries the exact Session generation, Actor, idempotency key, desired rows/columns, and the screen's observed `expectedGeometryVersion`.

- Reusing one key with the identical request returns the existing Action.
- Reusing it with different geometry returns `IDEMPOTENCY_KEY_REUSED`.
- A stale geometry version returns retryable `GEOMETRY_CHANGED` before allocating an Action.
- A new request for the already-current dimensions is invalid; an idempotent replay of an earlier delivered resize still returns that Action.

Human and Agent Actors may resize. Scheduler/System do not gain resize capability implicitly. Resize follows the generation's input policy and active Human Interaction Guard because `SIGWINCH` and reflow can change the meaning of a TUI while another Actor is interacting. It is accepted in READY, RESERVED, or RUNNING, but not STARTING, BROKEN, or CLOSED.

### Durable and live ordering

PostgreSQL commits the accepted Action, action sequence, requested geometry, and next geometry version before any PTY side effect. It revalidates generation, owner, status, policy, Guard, Action sequence, and expected geometry version in one transaction.

Before the live write, the Runtime durably records `terminal.resize_write_attempted`. It then:

1. reserves the next visible `screenVersion`;
2. queues the matching headless projection resize;
3. synchronously calls node-pty resize in the same JavaScript turn;
4. awaits the serialized headless reflow;
5. commits `terminal.resized` and marks the Action `DELIVERED`.

Queueing the projection first ensures any `SIGWINCH` output emitted after node-pty resize is parsed at the new geometry. PTY output and projection writes retain their existing ordered screen-version lane.

If the RPC result is lost, the caller receives `DELIVERY_UNKNOWN` and must reconcile the idempotency key/events before retrying. If node-pty resize or headless reflow fails after the write-attempt boundary, the Action becomes `UNKNOWN` and the Session generation becomes `BROKEN`; the Runtime never guesses which geometry won or replays the resize.

### Observation and diffs

`screen_get`, regions, cells, search, waits, and the Human Console use the current dynamic geometry. Region bounds are validated against the live frame rather than the original 120×40 constants.

A row diff can only be applied when both revisions have the same geometry. Crossing a resize returns `resyncRequired: true`, reason `geometry_changed`, and the current full snapshot. A full snapshot remains bounded by the maximum geometry.

The Console exposes an explicit resize form populated from the current canonical screen. It resizes its browser xterm only after receiving the Runtime snapshot. Multiple viewers independently render the same canonical geometry; none sends resize because its DOM changed.

## Consequences

- Human and Agent can deliberately drive real PTY `SIGWINCH` and headless reflow through one auditable path.
- Geometry races converge through version CAS instead of last-writer-wins viewer behavior.
- Resize adds a durable desired fact, but PostgreSQL still cannot recreate a lost PTY or prove live geometry after an unknown attempt.
- Dynamic regions and browser rendering require current-frame bounds; clients must stop assuming 120×40.
- Fixed cell/pixel metrics, automatic responsive fitting, per-viewer zoom, and remote capability policy remain later work.

## Rejected alternatives

- **Browser `fit()` owns node-pty:** makes layout and connection order shared-runtime policy.
- **Last resize wins without CAS:** permits stale viewers to overwrite a newer canonical decision.
- **Resize as an untracked RPC control:** bypasses Action attribution, idempotency, durability, Guard, and unknown delivery.
- **Resize only the headless screen:** diverges Agent observation from the real kernel PTY and foreground process.
- **Resize only node-pty and replay output:** cannot reconstruct the exact VT reflowed viewport.
- **Automatically retry after transport failure:** may duplicate an already-applied side effect.
