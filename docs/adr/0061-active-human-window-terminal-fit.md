# ADR-0061: Fit shared geometry to the active Human window

- Status: Accepted
- Date: 2026-09-02
- Amends: ADR-0025 (Console resize initiation only)

## Decision

The Human has explicitly accepted shared geometry following the operating window. The Console
defaults to responsive fitting after a real pointer or keyboard interaction in the terminal.
Connecting, programmatic editor focus, receiving snapshots, and reconnecting are not resize
intent. Switching Session, hiding the document, or losing window focus relinquishes fitting;
the next terminal interaction activates it again. Only a visible, focused window may submit.

The active window measures its terminal container and rendered cell size. Actual container
changes (including an inspector opening) are debounced by 180 ms. Dimensions are floored and
clamped to the Runtime's advertised bounds. Draft height and incoming canonical dimensions
do not independently trigger requests. Passive viewers render canonical snapshots, including
overflow when their windows are smaller. This is not a distributed exclusive-owner lease:
different hosts can still request concurrently, and geometry-version CAS arbitrates them.

Every change remains an ordinary Human ResizeAction with the exact generation, fresh unique
idempotency key, and observed geometry version. Existing Application capability, policy, Guard,
durability, PTY/projection ordering, and unknown-delivery rules are unchanged. The browser
xterm changes dimensions only from canonical snapshots, never from its own measurement.

Only one automatic request may be outstanding. Later layout intent is coalesced and waits for
both the HTTP response and a newer canonical geometry observation. Equal dimensions are a no-op.
CAS or policy rejection pauses fitting until a new terminal interaction; no error-triggered
retry occurs. Uncertain delivery locks automatic fitting for that selected-generation controller;
the user must reconcile observed state before reopening/reloading it. Hidden or switched-away
windows never replay a queued request. Already accepted Actions cannot be cancelled by blur.

Advanced offers a local "Fit terminal to active window" checkbox and a quiet status message.
Manual resize disables automatic fitting in that page so its dimensions are not immediately
overwritten. No new bottom panel, modal, or permanent terminal toolbar is introduced.

## Consequences and boundaries

- Native programs receive real PTY size changes and SIGWINCH through the existing auditable path.
- A large window uses additional terminal rows instead of scrolling a fixed 40-row screen early.
- Background observers cannot cause a snapshot-driven resize feedback loop.
- Runtime defaults remain 120×40 before active fitting; minimum/maximum bounds still permit
  overflow or unused space on exceptionally small/large windows.
- There is no database migration, new endpoint, Actor elevation, or PTY ownership transfer.
- Terminal query replies, scrollback history, and arbitrary TUI compatibility remain separate.
