import type { Actor } from "@iterminal/domain";
import {
  MAX_TERMINAL_COLUMNS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLUMNS,
  MIN_TERMINAL_ROWS,
  RuntimeError,
} from "@iterminal/domain";
import {
  actionLookupTransportRequestSchema,
  artifactReadTransportRequestSchema,
  executeTransportRequestSchema,
  executionOutputReadTransportRequestSchema,
  executionWaitV2TransportRequestSchema,
  inputTransportRequestSchema,
  runtimeCapabilitiesRequestSchema,
} from "@iterminal/protocol";
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
const screenRectangle = z.strictObject({
  columnCount: z.number().int().min(1).max(MAX_TERMINAL_COLUMNS),
  generation,
  rowCount: z.number().int().min(1).max(MAX_TERMINAL_ROWS),
  sessionId,
  startColumn: z
    .number()
    .int()
    .min(0)
    .max(MAX_TERMINAL_COLUMNS - 1),
  startRow: z
    .number()
    .int()
    .min(0)
    .max(MAX_TERMINAL_ROWS - 1),
});

export const MCP_INSTRUCTIONS =
  "Use one shared Session and pass its exact generation and target execution to mutations. Execute returns before completion; observe with the operation's read tool. PTY_BUSY means wait or choose another Session. After DELIVERY_UNKNOWN, inspect the idempotency key/events before any retry. PTY output is one merged stream. Input/control must target the current generation/execution and obey policy/Guard. UNKNOWN means side effects are unconfirmed, not safe to replay. Approvals are exact, one-time Human decisions for Agent Execute. Never expose or submit secrets through ordinary observation/input.";

export function createMcpServer(gateway: RuntimeGateway, actor: Actor): McpServer {
  const server = new McpServer(
    { name: "iterminal", version: "0.7.1" },
    {
      instructions: MCP_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "runtime_capabilities",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read the connected Runtime or Router capability contract. Pass sessionId through a Router to inspect that exact live owner; absent features are unsupported.",
      inputSchema: runtimeCapabilitiesRequestSchema,
      title: "Get Runtime capabilities",
    },
    async (input) =>
      call(async () => {
        if (gateway.getRuntimeCapabilities === undefined) {
          throw new RuntimeError(
            "INVALID_REQUEST",
            "Connected Runtime does not support capability negotiation",
          );
        }
        return gateway.getRuntimeCapabilities(input);
      }),
  );

  server.registerTool(
    "action_lookup",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Look up an accepted Action by this authenticated Actor's exact Session, generation, and idempotency key. not_found does not prove the original request was never accepted or is no longer in flight; never generate a replacement key from that result.",
      inputSchema: actionLookupTransportRequestSchema,
      title: "Look up accepted Action",
    },
    async (input) =>
      call(() =>
        gateway.lookupAction({
          actor,
          generation: input.generation,
          idempotencyKey: input.idempotencyKey,
          sessionId: input.sessionId,
        }),
      ),
  );

  server.registerTool(
    "artifact_read",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read a bounded byte range from a retained, already-sanitized Artifact in one exact Session generation. Base64 is lossless and authoritative; text is included only when the returned range is complete UTF-8. If textStatus is unaligned_utf8, concatenate the base64 bytes across ranges before decoding. Defaults to 8 KiB and allows at most 64 KiB per read.",
      inputSchema: artifactReadTransportRequestSchema,
      title: "Read retained Artifact bytes",
    },
    async (input) =>
      call(async () =>
        artifactMcpView(
          await gateway.readArtifact({
            artifactId: input.artifactId,
            generation: input.generation,
            ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
            offsetBytes: input.offsetBytes,
            sessionId: input.sessionId,
          }),
        ),
      ),
  );

  server.registerTool(
    "execution_output_read",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read one bounded continuous window of already-sanitized durable PTY bytes for an exact Execution. Base64 chunks are authoritative. Defaults to 8 KiB and allows at most 64 KiB. hasMore describes only the current durable continuous window; RUNNING with hasMore=false may still produce output, and persistenceLag=possible means the live PTY may be ahead. An Artifact gap must be acknowledged before using its resumeCursor.",
      inputSchema: executionOutputReadTransportRequestSchema,
      title: "Read continuous Execution output",
    },
    async (input) =>
      call(() =>
        gateway.readExecutionOutput({
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          executionId: input.executionId,
          generation: input.generation,
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
          sessionId: input.sessionId,
        }),
      ),
  );

  server.registerTool(
    "session_create",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Idempotently create one live persistent bash/zsh PTY Session rooted at an existing workspace. Reuse the same key after DELIVERY_UNKNOWN. All actors using this Session share cwd, exported environment, and foreground process.",
      inputSchema: z.strictObject({
        idempotencyKey: z.string().min(1).max(256),
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
    "session_checkpoint",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read checkpoint metadata for the exact generation; values and process/editor state are omitted. stale means the last completed boundary is used.",
      inputSchema: z.strictObject({ generation, sessionId }),
      title: "Inspect Session checkpoint",
    },
    async ({ generation: requestedGeneration, sessionId: requestedSessionId }) =>
      call(() => gateway.getSessionCheckpoint(requestedSessionId, requestedGeneration)),
  );

  server.registerTool(
    "session_fork",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Create a Session from an exact checkpoint. Set allowStale only after accepting the parent's last completed boundary; retry uncertainty with the same idempotencyKey.",
      inputSchema: z.strictObject({
        allowStale: z.boolean().default(false),
        expectedCheckpointVersion: z.number().int().positive(),
        generation,
        idempotencyKey,
        sessionId,
      }),
      title: "Fork Session from checkpoint",
    },
    async (input) =>
      call(() =>
        gateway.forkSession({
          actor,
          allowStale: input.allowStale,
          expectedCheckpointVersion: input.expectedCheckpointVersion,
          idempotencyKey: input.idempotencyKey,
          sessionGeneration: input.generation,
          sessionId: input.sessionId,
        }),
      ),
  );

  server.registerTool(
    "session_list",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: "List live Sessions from the Runtime daemon or Router.",
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
        "Close the exact generation and terminate its PTY/process group; closed state cannot resume.",
      inputSchema: z.strictObject({ generation, sessionId }),
      title: "Close terminal Session",
    },
    async ({ generation: requestedGeneration, sessionId: requestedSessionId }) =>
      call(() => gateway.closeSession(requestedSessionId, requestedGeneration)),
  );

  server.registerTool(
    "approval_request",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Request Human approval for one exact Agent Execute proposal. Reuse requestIdempotencyKey only for the identical proposal; this does not execute it.",
      inputSchema: z.strictObject({
        actionIdempotencyKey: idempotencyKey,
        command: z
          .string()
          .min(1)
          .max(256 * 1024),
        generation,
        reason: z.string().min(1).max(512),
        requestIdempotencyKey: idempotencyKey,
        sessionId,
        ttlMilliseconds: z
          .number()
          .int()
          .min(30_000)
          .max(30 * 60 * 1_000)
          .optional(),
      }),
      title: "Request exact Execute approval",
    },
    async (input) =>
      call(() =>
        gateway.requestExecuteApproval({
          actionIdempotencyKey: input.actionIdempotencyKey,
          actor,
          command: input.command,
          reason: input.reason,
          requestIdempotencyKey: input.requestIdempotencyKey,
          sessionGeneration: input.generation,
          sessionId: input.sessionId,
          ...(input.ttlMilliseconds === undefined
            ? {}
            : { ttlMilliseconds: input.ttlMilliseconds }),
        }),
      ),
  );

  server.registerTool(
    "approval_get",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read one Approval for this exact Agent; only its bound APPROVED proposal may consume it once.",
      inputSchema: z.strictObject({
        approvalId: z.string().min(1).max(256),
        generation,
        sessionId,
      }),
      title: "Get Execute approval",
    },
    async (input) =>
      call(() =>
        gateway.getApproval({
          actor,
          approvalId: input.approvalId,
          sessionGeneration: input.generation,
          sessionId: input.sessionId,
        }),
      ),
  );

  server.registerTool(
    "approval_list",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "List this Agent's newest Approvals in one Session generation; other Agents' proposals are hidden.",
      inputSchema: z.strictObject({
        generation,
        sessionId,
        status: z.enum(["PENDING", "APPROVED", "DENIED", "EXPIRED", "CONSUMED"]).optional(),
      }),
      title: "List Execute approvals",
    },
    async (input) =>
      call(() =>
        gateway.listApprovals({
          actor,
          sessionGeneration: input.generation,
          sessionId: input.sessionId,
          ...(input.status === undefined ? {} : { status: input.status }),
        }),
      ),
  );

  server.registerTool(
    "execute",
    {
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Start one top-level Shell command; returns Action/Execution immediately. approvalId binds an exact Human-approved proposal. Reuse idempotencyKey only for the identical request.",
      inputSchema: executeTransportRequestSchema,
      title: "Execute in shared terminal",
    },
    async ({
      approvalId,
      command,
      generation: requestedGeneration,
      idempotencyKey: key,
      sessionId: id,
    }) =>
      call(() =>
        gateway.startExecute({
          actor,
          ...(approvalId === undefined ? {} : { approvalId }),
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
        "Legacy wait until an Execution becomes terminal. Prefer execution_wait_v2 for a bounded, cancellable observation. This does not replay or alter it.",
      inputSchema: z.strictObject({ executionId }),
      title: "Wait for terminal Execution",
    },
    async ({ executionId: id }) => call(() => gateway.waitExecution(id)),
  );

  server.registerTool(
    "execution_wait_v2",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Wait at most waitMs for an exact Execution to become terminal. Defaults to 10 seconds; 0 returns an immediate snapshot; maximum is 30 seconds. Timeout returns completed=false with the current state. completed=true means terminal, not successful. Cancellation stops only this observation and never sends terminal input or control.",
      inputSchema: executionWaitV2TransportRequestSchema,
      title: "Wait bounded time for terminal Execution",
    },
    async (input, extra) =>
      call(() => {
        if (gateway.waitExecutionV2 === undefined) {
          throw new RuntimeError(
            "INVALID_REQUEST",
            "Connected Runtime does not support bounded Execution wait",
          );
        }
        return gateway.waitExecutionV2(input, extra.mcpReq.signal);
      }),
  );

  server.registerTool(
    "interaction_get",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read the exact Session generation's input policy, version, active short Human Guard, and live inputContext (targetExecutionId, version, clear/pending/unknown). Output alone does not change inputContext. A clear context only excludes Runtime-observed pending input; it is not proof of application readiness. This tool cannot mutate Human policy or acquire a Guard.",
      inputSchema: z.strictObject({ generation, sessionId }),
      title: "Get terminal interaction policy",
    },
    async ({ generation: requestedGeneration, sessionId: requestedSessionId }) =>
      call(() => gateway.getInteractionState(requestedSessionId, requestedGeneration)),
  );

  server.registerTool(
    "input",
    {
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Write input to the exact foreground Execution. Use expectedScreenVersion for screen-dependent input; use lineInput only for one printable LF-ended line with its two context versions. Do not use lineInput for TUI/editor/password/confirmation. Re-observe changed or guarded targets before retrying.",
      inputSchema: inputTransportRequestSchema,
      title: "Send targeted terminal input",
    },
    async (input) =>
      call(() =>
        gateway.sendInput({
          actor,
          data: input.data,
          ...(input.lineInput === undefined ? {} : { lineInput: input.lineInput }),
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
        "Deliver either explicit TTY control bytes or a process-group signal to the exact active Execution. Ctrl+D is a TTY byte, not a guaranteed EOF event. Prefer CTRL_C before stronger signals. Agent MCP Control cannot bypass Human Guards or policy.",
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
    "terminal_resize",
    {
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        "Explicitly resize the shared generation-owned PTY and canonical Virtual Screen. Pass geometryVersion from screen_get as expectedGeometryVersion. The Runtime serializes reflow, applies input policy/Human Guard, and records an attributed ResizeAction. GEOMETRY_CHANGED means another Actor resized first; re-observe before deciding. Never retry DELIVERY_UNKNOWN without reconciling the idempotency key/events.",
      inputSchema: z.strictObject({
        columns: z.number().int().min(MIN_TERMINAL_COLUMNS).max(MAX_TERMINAL_COLUMNS),
        expectedGeometryVersion: z.number().int().positive(),
        idempotencyKey,
        generation,
        rows: z.number().int().min(MIN_TERMINAL_ROWS).max(MAX_TERMINAL_ROWS),
        sessionId,
      }),
      title: "Resize shared terminal geometry",
    },
    async (input) =>
      call(() =>
        gateway.resizeTerminal({
          actor,
          columns: input.columns,
          expectedGeometryVersion: input.expectedGeometryVersion,
          idempotencyKey: input.idempotencyKey,
          rows: input.rows,
          sessionGeneration: input.generation,
          sessionId: input.sessionId,
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
        "Read the exact live Session generation's bounded canonical Virtual Screen after ANSI/VT parsing. Returns dynamic rows/columns, geometryVersion, active normal/alternate buffer, zero-based cursor, plain-text rows, and screenVersion for guarded input.",
      inputSchema: z.strictObject({ generation, sessionId }),
      title: "Get live terminal screen",
    },
    async ({ generation: requestedGeneration, sessionId: requestedSessionId }) =>
      call(() => gateway.getScreen(requestedSessionId, requestedGeneration)),
  );

  server.registerTool(
    "terminal_state",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Classify the exact live terminal as shell_ready, running, editor, pager, repl, password, confirm, or unknown using bounded enumerated evidence tied to one screen frame. The result is always advisory: screen text can be spoofed, command family may not be the current foreground child, and password-like output does not activate a secret channel. Never use this tool alone for readiness, completion, authorization, approval, target selection, or automatic input; verify Session/Execution IDs, versions, interaction policy, and screen evidence separately.",
      inputSchema: z.strictObject({ generation, sessionId }),
      title: "Inspect advisory terminal state",
    },
    async ({ generation: requestedGeneration, sessionId: requestedSessionId }) =>
      call(() => gateway.getTerminalState(requestedSessionId, requestedGeneration)),
  );

  server.registerTool(
    "screen_region",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read one rectangular slice of the current active canonical viewport using zero-based terminal-cell coordinates. Bounds must fit the live geometry returned by screen_get. Wide glyphs clipped by a boundary are returned as blank cells. This does not read scrollback.",
      inputSchema: screenRectangle,
      title: "Read live terminal screen region",
    },
    async (input) => call(() => gateway.getScreenRegion(input)),
  );

  server.registerTool(
    "screen_cells",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read row-major material cells and sparse standard SGR styles from one bounded current-viewport rectangle. Default blank and wide-continuation cells are omitted. Colors are explicit palette indexes or RGB channels; request the smallest useful region.",
      inputSchema: screenRectangle,
      title: "Read styled live terminal cells",
    },
    async (input) => call(() => gateway.getScreenCells(input)),
  );

  server.registerTool(
    "screen_diff",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Read bounded full-row replacements after a retained screenVersion. Future, expired, or cross-geometry versions return resyncRequired=true with the current full snapshot; no missing delta or resize reflow is fabricated.",
      inputSchema: z.strictObject({
        afterVersion: z.number().int().nonnegative(),
        generation,
        sessionId,
      }),
      title: "Diff live terminal screen",
    },
    async (input) => call(() => gateway.getScreenDiff(input)),
  );

  server.registerTool(
    "screen_search",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      description:
        "Search literal text only in the current active canonical viewport. Returns at most maxMatches terminal-cell row/column ranges tied to one exact screen snapshot; it does not search scrollback or durable Events.",
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

export function artifactMcpView(
  result: Awaited<ReturnType<RuntimeGateway["readArtifact"]>>,
): Awaited<ReturnType<RuntimeGateway["readArtifact"]>> &
  Readonly<{ text?: string; textStatus?: "complete" | "unaligned_utf8" }> {
  if (result.kind !== "found") return result;
  try {
    return {
      ...result,
      text: new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(result.contentBase64, "base64"),
      ),
      textStatus: "complete",
    };
  } catch {
    return { ...result, textStatus: "unaligned_utf8" };
  }
}
