# M1 single-process Runtime and CLI verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (single-process component/runtime path).** The modular Application Service drove real local bash/zsh PTYs through the production package boundary, with an in-memory repository and a long-lived JSONL CLI adapter. This is not durable, MCP, Web, L3, or user acceptance evidence.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- pnpm: 10.33.2
- bash: GNU bash 3.2.57(1)-release
- zsh: 5.9
- node-pty: 1.2.0-beta.12
- Python fixture: local `python3 -q`

## Automated gate

```bash
pnpm verify
```

Result: exit 0. Prettier, ESLint, TypeScript no-emit checking, 4 Vitest files / 11 tests, verification-report checks, and the declaration/source-map build passed.

The real-runtime scenarios proved:

| Scenario                                                             | Result                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Agent changes cwd/env, Human reads the same top-level Shell state    | PASS on bash and zsh                                        |
| Competing Execute while Python owns the foreground                   | `PTY_BUSY` with structured next actions                     |
| Human and Agent InputAction batches target the same Python execution | PASS; Python printed `42`                                   |
| Stale execution target                                               | `EXECUTION_CHANGED`                                         |
| Stale screen precondition                                            | `SCREEN_CHANGED`                                            |
| Same idempotency key and request                                     | Original Execution replayed                                 |
| Same idempotency key with changed request                            | `IDEMPOTENCY_KEY_REUSED`                                    |
| Wrong Session generation                                             | `SESSION_GENERATION_CHANGED`                                |
| Human TTY Ctrl+C targets Agent sleep                                 | Delivered; Execution `INTERRUPTED`, exit 130; Session READY |
| Bounded output buffer                                                | Newest bytes retained with truncation metadata              |

## Real CLI path

A long-lived `pnpm cli` process received JSONL requests through stdin:

1. `create` returned a READY zsh Session generation 1.
2. `execute` accepted a Human Action without waiting for command completion.
3. `wait` returned COMPLETED, exit 0, `CLI=works`, and cwd ending in `/packages`.
4. `events` returned 22 ordered events including accepted, dispatching, started, completed, and shell_ready.
5. `close` returned CLOSED; EOF then exited the CLI process with code 0.

This proves the CLI delegates to `RuntimeService`; it does not prove a cross-process daemon or reconnect path.

## Architecture evidence

- `@iterminal/domain` has no adapter dependency.
- `@iterminal/application` depends on Domain and defines RuntimeStore/ShellExecutor ports.
- Memory storage, PTY execution, testkit, protocol, and CLI are replaceable packages around those ports.
- Session reservation is one atomic MemoryRuntimeStore transition from READY to RESERVED; no in-Session Execute queue exists.
- Accepted Actions receive monotonic action sequence numbers; Events receive generation-scoped sequence numbers.
- PTY output is merged and bounded; Input and Control can write only to the active generation/execution.
- TTY controls and foreground process-group signals are separate delivery modes. Only the TTY Ctrl+C path is exercised at L2 in M1.

## Not proven

- PostgreSQL durability, transactional CAS, outbox, crash recovery, cross-process ownership, or reconnect.
- MCP, HTTP, WebSocket, Virtual Screen, Human Console, queueing, RabbitMQ, or multi-worker routing.
- User rc/prompt frameworks, Linux CI results, or the process-signal path at L2.
- Security against same-user malicious code. The production adapter still uses a private FIFO; close-on-exec/supervisor channel hardening remains open.
- L3 real Human Console plus real MCP Agent, L4 acceptance, capacity, or long-duration soak.
