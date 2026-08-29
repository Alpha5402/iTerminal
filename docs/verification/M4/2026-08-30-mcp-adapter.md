# M4 MCP adapter verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real stdio MCP, daemon RPC, PTY, and Shell integration).** The official MCP TypeScript Client executed the complete tool path through a real stdio child process, Unix socket Runtime daemon, and zsh PTY. OpenCode and Claude Code independently completed local stdio MCP health handshakes. No model-driven Agent run was authorized, so M4 has not passed its L3 Exit Gate.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- MCP SDK: `@modelcontextprotocol/server` and `client` 2.0.0
- OpenCode: 1.18.25, temporary `npx` execution
- Claude Code: 2.1.251, temporary `npx` execution with isolated `CLAUDE_CONFIG_DIR`
- Shell/PTY: real zsh through node-pty

Temporary OpenCode/Claude configurations and daemon sockets were removed after the checks. No OpenCode, Claude, or Codex model request was made.

## Commands and results

```bash
pnpm test:m4
OPENCODE_CONFIG=<temporary-config> OPENCODE_PURE=1 npx -y opencode-ai@1.18.25 mcp list
CLAUDE_CONFIG_DIR=<temporary-dir> npx -y @anthropic-ai/claude-code@2.1.251 mcp list
```

- Official SDK integration: exit 0; 1 file / 1 scenario passed.
- OpenCode: exit 0; reported `✓ iterminal connected`.
- Claude Code: exit 0; reported `✔ Connected` from an isolated user-scope config.

## Proven scenarios

| Scenario         | Result                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Tool discovery   | All ten M4 tools and generated schemas returned through `tools/list`                      |
| stdout purity    | Official Client completed initialize/list/call parsing while bridge logs stayed on stderr |
| Shared Shell     | Agent `cd subdir && export ITERM_M4=shared`; later MCP execution observed both values     |
| Client restart   | First stdio Client closed; second bridge reconnected to the same daemon-owned Session/PTY |
| Cursor recovery  | First Client saved `nextAfter`; second resumed Events after that sequence                 |
| Busy arbitration | Competing Execute returned structured `PTY_BUSY` with no queue                            |
| Targeted Input   | Two Input calls operated the same live Python Execution and printed `42`                  |
| Control          | MCP `CTRL_C` interrupted `sleep 10`; Execution became INTERRUPTED                         |
| Idempotency      | Repeated identical Execute key returned the original Action                               |
| Product clients  | OpenCode and Claude Code each initialized the stdio server successfully                   |

## Not proven

- A real model autonomously choosing and calling the tools. A minimal Codex model call was refused by the execution safety reviewer because it could transmit local Session metadata externally without explicit user authorization.
- L3 Human Console + MCP Agent collaboration; the Human Console does not exist yet.
- PostgreSQL-backed daemon state, daemon crash/restart recovery, cross-host routing, or durable Events in the live MCP path.
- Authentication, authorization, approval policy, OS sandboxing, secret redaction, or multi-user socket access beyond mode `0600`.
- Linux product-client handshakes, long-running soak, request cancellation, or hostile MCP/RPC fuzzing.
