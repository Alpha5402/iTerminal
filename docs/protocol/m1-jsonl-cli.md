# M1 JSONL CLI protocol

The M1 CLI is a long-lived local process because an in-memory Runtime and its PTYs cannot survive one-shot CLI invocations. Each stdin line is one JSON request; stdout contains JSON responses only and diagnostics go to stderr.

Supported operations:

- `create`: `{ "op": "create", "shell": "zsh", "workspaceRoot": "/absolute/path" }`
- `status`: `{ "op": "status", "sessionId": "..." }`
- `execute`: Execute request fields plus `op`; returns accepted Action/Execution immediately.
- `wait`: `{ "op": "wait", "executionId": "..." }`
- `input`: Input request fields plus `op`.
- `control`: Control request fields plus `op`.
- `events`: `{ "op": "events", "sessionId": "...", "generation": 1, "after": 0, "limit": 100 }`
- `close`: `{ "op": "close", "sessionId": "...", "generation": 1 }`

The canonical write fixtures are in `packages/protocol/fixtures/actions.json`. The CLI is an adapter over `RuntimeService`; it never writes the PTY directly.
