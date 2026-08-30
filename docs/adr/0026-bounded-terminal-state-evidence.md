# ADR-0026: Bounded advisory terminal-state evidence

- Status: Accepted for M6.7
- Date: 2026-08-30

## Context

The Runtime already knows authoritative Session and Execution state from the Shell Integration control channel, and it owns an exact-generation ANSI/VT screen projection. An Agent can read those facts, but it must currently infer whether a RUNNING foreground interaction resembles an editor, pager, REPL, confirmation, or password-like prompt.

Those labels are useful for choosing what to inspect next, but terminal text is not trustworthy control data. Any program can print `Password:`, `>>>`, `(END)`, or editor-like status text. A top-level command may start a different child process, and an alternate buffer does not identify the program that owns it. Screen stability proves only that no new screen version arrived during an interval. None of these signals proves readiness, completion, authorization, approval, input safety, or secret handling.

## Decision

### Live read-only observation

The Runtime exposes one exact-generation, read-only terminal-state observation through Runtime RPC as `terminal.state.get` and MCP as `terminal_state`.

The result is tied to one current screen frame and contains only bounded fields:

```ts
interface TerminalStateObservation {
  advisory: true;
  kind:
    "shell_ready" | "running" | "editor" | "pager" | "repl" | "password" | "confirm" | "unknown";
  confidence: "high" | "medium" | "low";
  evidence: readonly TerminalStateEvidence[];
  limitations: readonly TerminalStateLimitation[];
  frame: TerminalScreenFrame;
  sessionStatus: SessionStatus;
  executionId?: string;
  observedAt: string;
}
```

Evidence and limitation values are closed enums. They never contain raw commands, screen lines, entered text, environment values, or inferred secrets. The response contains at most eight evidence items and eight limitations, and the screen content remains available separately through the existing bounded screen tools.

This first slice is process-local live state. The read is serialized with Session mutations so its Session/Execution facts cannot cross an Execute transition while the exact screen frame is captured. It does not write an Event or mutate `session_snapshots`; a later durable observer may persist a versioned DTO under a separate decision. A daemon restart cannot recreate the lost PTY or its classification.

### Fact and heuristic boundary

The classifier applies this precedence:

1. An authoritative Runtime `READY` Session yields `shell_ready` with high confidence, regardless of prompt-like text left on screen.
2. A Session that is not `RUNNING` yields `unknown`; `RESERVED` does not claim the command is already running.
3. A `RUNNING` Session always has runtime-fact evidence for the exact active Execution.
4. Password-like and confirmation-like text in the active viewport may yield `password` or `confirm`, but confidence remains low because this version does not observe terminal echo mode or application protocol.
5. A conservatively parsed first simple command basename may contribute an `editor`, `pager`, `repl`, or monitor-family signal. Shell composition, substitutions, pipelines, aliases, functions, wrappers, and nested interpreters are not evaluated.
6. Recognized command families yield medium-confidence `editor`, `pager`, or `repl`. Matching alternate-buffer or viewport markers can add evidence but cannot raise these labels above medium.
7. Every other exact RUNNING Execution yields generic `running` with high confidence. A monitor such as `top` remains `running` and carries a bounded monitor-family signal.

The classifier never shells out, evaluates the command, scans scrollback, reads the process environment, or treats arbitrary output as a control marker.

### Safety constraints

`TerminalStateObservation` is advisory and MUST NOT be the sole input to:

- Action admission, Input Policy, Interaction Guard, Approval, or capability decisions;
- deciding that a password/secret channel is active;
- deciding that a command completed or the Shell is READY;
- selecting an Execution target or bypassing generation, Execution, screen, or geometry freshness;
- automatically sending Enter, `y`, a password, Ctrl+C, or any other input/control;
- reconstructing live state after Runtime loss.

Clients continue to use Session/Execution state, exact IDs, versions, policies, Guards, and explicit Human decisions for those behaviors. `screen_wait` stability retains its existing meaning and does not become a TerminalState transition.

## Consequences

- Agents gain a small, explainable hint surface without receiving unbounded transcript data or opaque model output.
- False positives remain possible and visible through low/medium confidence plus explicit limitations.
- Command and screen spoof fixtures become part of the contract, preventing prompt-looking output from overriding authoritative READY state.
- New classifiers can be added only by extending closed evidence enums, fixtures, and this safety boundary; regex accumulation alone is not sufficient.
- Process-name inspection, terminal echo-mode evidence, localized prompt packs, pixel/mouse evidence, and durable state history remain later work.

## Rejected alternatives

- **Return a single opaque label:** hides why the Runtime guessed and invites callers to treat it as fact.
- **Use screen stability as readiness:** quiet TUIs, blocked reads, and sleeping processes are stable without being READY.
- **Trust prompt text or shell prompt characters:** terminal output is spoofable and locale/theme dependent.
- **Evaluate or fully parse the shell command:** duplicates Shell semantics and can still differ from the current foreground process.
- **Persist every read as an Event/Snapshot:** makes observation mutate durable truth and records stale guesses without a lifecycle policy.
- **Use an LLM classifier in the Runtime:** makes a safety-adjacent read non-deterministic, expensive, and difficult to bound or reproduce.
