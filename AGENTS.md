# AGENTS.md

## Mission

Build iTerminal as a Human-Agent shared terminal runtime. Optimize for truthful execution semantics, explicit failure states, and reusable boundaries—not for feature count.

## Governing documents

Read these before changing runtime behavior:

1. `TODO.md`
2. `docs/TERMINOLOGY.md`
3. `docs/adr/README.md` and the relevant ADRs
4. The latest evidence under `docs/verification/`

## Non-negotiable invariants

- One Session generation owns exactly one persistent PTY and Shell.
- All Human/Agent writes go through the Application layer as Actions.
- A Session accepts at most one active ExecuteAction; contention returns `PTY_BUSY`.
- Input/Control must target the current generation and Execution.
- PTY output is a merged byte stream; do not invent stdout/stderr attribution.
- PostgreSQL stores durable accepted/observed facts; it does not recreate live PTY truth.
- Unknown delivery or side effects become `UNKNOWN`; never auto-replay them.
- Losing the PTY creates a broken generation. Rebuild is a new generation.

## Dependency direction

```text
domain <- application <- adapters/apps
```

Transport and infrastructure code must not own state transitions. HTTP, WebSocket, CLI, and MCP call the same Application services.

## Engineering workflow

- Work milestone by milestone and keep the relevant TODO checkboxes/evidence current.
- Add or revise an ADR before changing states, ordering, durability, ownership, security, or protocol semantics.
- Keep commits conventional and cohesive. Direct commits to `main` are allowed for this repository.
- Before each commit/push closure, run `pnpm verify` plus the milestone's real scenario checks.
- Do not rerun the entire suite after every small edit unless the edit is high risk or a failure needs isolation.
- Never commit `.env`, logs, databases, recordings, artifacts, secrets, or generated caches.

## Completion language

- L0: design/static review
- L1: unit/property/contract tests
- L2: real local PTY/Shell/PostgreSQL integration
- L3: real Human Console + real MCP Agent path
- L4: failure injection, pressure, security, cross-platform, and dogfood

State the achieved level. Do not turn L1/L2 evidence into an L3/L4 claim.

## Commit attribution

When Codex authors a commit, the final commit-message paragraph may be:

```text
Co-authored-by: Codex <codex@openai.com>
```
