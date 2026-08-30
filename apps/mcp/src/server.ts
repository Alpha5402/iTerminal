import type { Actor } from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";
import type { RuntimeGateway } from "@iterminal/runtime-rpc";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const sessionId = z.string().min(1).max(256).describe("Session ID returned by session_create");
const generation = z
  .number()
  .int()
  .positive()
  .describe("Exact Session generation; stale generations are rejected");
const executionId = z.string().min(1).max(256).describe("Execution ID returned by execute");
const idempotencyKey = z
  .string()
  .min(1)
  .max(256)
  .describe("Caller-generated retry key; reuse only for the identical request");

export function createMcpServer(gateway: RuntimeGateway, actor: Actor): McpServer {
  const server = new McpServer(
    { name: "iterminal", version: "0.6.2" },
    {
      instructions:
        "Create or select one shared Session, then pass its exact generation to every operation. " +
        "execute starts one top-level Shell command and returns immediately; use execution_wait or events_query to observe it. " +
        "PTY_BUSY means another Execute is active: wait for it, send targeted input/control if appropriate, or use another Session. " +
        "BACKPRESSURE means no Action was admitted; wait for durable delivery capacity and retry the identical idempotency key. " +
        "Never retry a mutating call after DELIVERY_UNKNOWN without first inspecting the idempotency key or durable events.",
    },
  );

  server.registerTool(
    "session_create",
    {
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Create one live persistent bash/zsh PTY Session rooted at an existing workspace. All actors using this Session share cwd, exported environment, and foreground process.",
      inputSchema: z.strictObject({
        shell: z.enum(["bash", "zsh"]),
        workspaceRoot: z.string().min(1).max(4096),
      }),
      title: "Create shared terminal Session",
    },
    async (input) => call(() => gateway.createSession(input)),
  );

  server.registerTool(
    "session_get",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read current live Session status, generation, active Execution, screen version, Shell, and workspace root.",
      inputSchema: z.strictObject({ sessionId }),
      title: "Get terminal Session",
    },
    async ({ sessionId: requestedSessionId }) => call(() => gateway.getSession(requestedSessionId)),
  );

  server.registerTool(
    "session_list",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: "List live Sessions known to the local Runtime daemon.",
      inputSchema: z.strictObject({}),
      title: "List terminal Sessions",
    },
    async () => call(() => gateway.listSessions()),
  );

  server.registerTool(
    "session_close",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
      description:
        "Close the exact Session generation and terminate its PTY/process group. Closed live state cannot be resumed.",
      inputSchema: z.strictObject({ generation, sessionId }),
      title: "Close terminal Session",
    },
    async ({ generation: requestedGeneration, sessionId: requestedSessionId }) =>
      call(() => gateway.closeSession(requestedSessionId, requestedGeneration)),
  );

  server.registerTool(
    "execute",
    {
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Start one top-level command in the Session's persistent Shell and return its Action/Execution immediately. " +
        "Only one Execute may be active. On PTY_BUSY, inspect activeExecutionId and choose execution_wait, input, or control. " +
        "On BACKPRESSURE, no Action/reservation exists: wait for Outbox capacity and retry this identical request key. Session forking arrives in a later milestone.",
      inputSchema: z.strictObject({
        command: z.string().max(256 * 1024),
        idempotencyKey,
        generation,
        sessionId,
      }),
      title: "Execute in shared terminal",
    },
    async ({ command, generation: requestedGeneration, idempotencyKey: key, sessionId: id }) =>
      call(() =>
        gateway.startExecute({
          actor,
          command,
          idempotencyKey: key,
          sessionGeneration: requestedGeneration,
          sessionId: id,
        }),
      ),
  );

  server.registerTool(
    "execution_get",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read current Execution state and its bounded captured output without waiting for completion.",
      inputSchema: z.strictObject({ executionId }),
      title: "Get terminal Execution",
    },
    async ({ executionId: id }) => call(() => gateway.getExecution(id)),
  );

  server.registerTool(
    "execution_wait",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Wait until an Execution becomes COMPLETED, INTERRUPTED, FAILED, or UNKNOWN. This does not replay or alter it.",
      inputSchema: z.strictObject({ executionId }),
      title: "Wait for terminal Execution",
    },
    async ({ executionId: id }) => call(() => gateway.waitExecution(id)),
  );

  server.registerTool(
    "input",
    {
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Atomically write one input batch to the exact active foreground Execution. Pass expectedScreenVersion when acting on observed screen state. " +
        "EXECUTION_CHANGED or SCREEN_CHANGED means refresh before deciding again.",
      inputSchema: z.strictObject({
        data: z.string().max(64 * 1024),
        expectedScreenVersion: z.number().int().nonnegative().optional(),
        idempotencyKey,
        generation,
        sessionId,
        targetExecutionId: executionId,
      }),
      title: "Send targeted terminal input",
    },
    async (input) =>
      call(() =>
        gateway.sendInput({
          actor,
          data: input.data,
          idempotencyKey: input.idempotencyKey,
          sessionGeneration: input.generation,
          sessionId: input.sessionId,
          targetExecutionId: input.targetExecutionId,
          ...(input.expectedScreenVersion === undefined
            ? {}
            : { expectedScreenVersion: input.expectedScreenVersion }),
        }),
      ),
  );

  server.registerTool(
    "control",
    {
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Deliver either explicit TTY control bytes or a process-group signal to the exact active Execution. Ctrl+D is a TTY byte, not a guaranteed EOF event. Prefer CTRL_C before stronger signals.",
      inputSchema: z.strictObject({
        delivery: z.discriminatedUnion("mode", [
          z.strictObject({
            control: z.enum(["CTRL_C", "CTRL_D", "CTRL_Z", "ESC"]),
            mode: z.literal("TTY_CONTROL"),
          }),
          z.strictObject({
            mode: z.literal("PROCESS_SIGNAL"),
            signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL", "SIGTSTP", "SIGCONT"]),
          }),
        ]),
        idempotencyKey,
        generation,
        sessionId,
        targetExecutionId: executionId,
      }),
      title: "Control foreground terminal process",
    },
    async (input) =>
      call(() =>
        gateway.sendControl({
          actor,
          delivery: input.delivery,
          idempotencyKey: input.idempotencyKey,
          sessionGeneration: input.generation,
          sessionId: input.sessionId,
          targetExecutionId: input.targetExecutionId,
        }),
      ),
  );

  server.registerTool(
    "events_query",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read a bounded generation-scoped Event page after a sequence cursor. Use nextAfter only when truncated is true; never infer missing live output from an empty page.",
      inputSchema: z.strictObject({
        after: z.number().int().nonnegative().default(0),
        generation,
        limit: z.number().int().min(1).max(500).default(100),
        sessionId,
      }),
      title: "Query terminal Event timeline",
    },
    async (input) =>
      call(() => gateway.queryEvents(input.sessionId, input.generation, input.after, input.limit)),
  );

  server.registerTool(
    "screen_get",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read the exact live Session generation's bounded 120x40 Virtual Screen after ANSI/VT parsing. Returns active normal/alternate buffer, zero-based cursor, plain-text rows, and screenVersion for guarded input.",
      inputSchema: z.strictObject({ generation, sessionId }),
      title: "Get live terminal screen",
    },
    async ({ generation: requestedGeneration, sessionId: requestedSessionId }) =>
      call(() => gateway.getScreen(requestedSessionId, requestedGeneration)),
  );

  server.registerTool(
    "screen_search",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Search literal text only in the current active 120x40 viewport. Returns at most maxMatches terminal-cell row/column ranges tied to one exact screen snapshot; it does not search scrollback or durable Events.",
      inputSchema: z.strictObject({
        caseSensitive: z.boolean().default(false),
        generation,
        maxMatches: z.number().int().min(1).max(100).default(20),
        query: z.string().min(1).max(1_024),
        sessionId,
      }),
      title: "Search live terminal screen",
    },
    async (input) =>
      call(() =>
        gateway.searchScreen({
          caseSensitive: input.caseSensitive,
          generation: input.generation,
          maxMatches: input.maxMatches,
          query: input.query,
          sessionId: input.sessionId,
        }),
      ),
  );

  server.registerTool(
    "screen_wait",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Wait without polling for visible text, a newer screen version, a no-change interval, or an exact Execution terminal state. Timeout returns matched=false with the latest bounded snapshot. Stable means no screenVersion change, not Shell readiness.",
      inputSchema: z.strictObject({
        condition: z.discriminatedUnion("type", [
          z.strictObject({
            caseSensitive: z.boolean().default(false),
            text: z.string().min(1).max(1_024),
            type: z.literal("text"),
          }),
          z.strictObject({
            afterVersion: z.number().int().nonnegative(),
            type: z.literal("version"),
          }),
          z.strictObject({
            stableMilliseconds: z.number().int().min(50).max(30_000),
            type: z.literal("stable"),
          }),
          z.strictObject({
            executionId,
            type: z.literal("execution_exit"),
          }),
        ]),
        generation,
        sessionId,
        timeoutMilliseconds: z.number().int().min(1).max(300_000).default(30_000),
      }),
      title: "Wait for live terminal evidence",
    },
    async (input) =>
      call(() =>
        gateway.waitForScreen({
          condition: input.condition,
          generation: input.generation,
          sessionId: input.sessionId,
          timeoutMilliseconds: input.timeoutMilliseconds,
        }),
      ),
  );

  return server;
}

async function call(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await work();
    const structuredContent = { result };
    return {
      content: [{ text: JSON.stringify(structuredContent), type: "text" }],
      structuredContent,
    };
  } catch (error) {
    const normalized =
      error instanceof RuntimeError
        ? {
            code: error.code,
            details: error.details,
            message: error.message,
            retryable: error.retryable,
          }
        : {
            code: "INTERNAL",
            details: {},
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          };
    return {
      content: [{ text: JSON.stringify({ error: normalized }), type: "text" }],
      isError: true,
    };
  }
}
