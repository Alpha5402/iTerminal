import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";

import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { Actor, EventPage, InteractionState, Session } from "@iterminal/domain";
import {
  ACTOR_CAPABILITY_PROFILES,
  CANONICAL_TERMINAL_COLUMNS,
  CANONICAL_TERMINAL_ROWS,
  MAX_TERMINAL_COLUMNS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLUMNS,
  MIN_TERMINAL_ROWS,
  RuntimeError,
} from "@iterminal/domain";
import type { RuntimeGateway } from "@iterminal/runtime-rpc";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
import * as z from "zod/v4";

const CONSOLE_COOKIE = "iterminal_console";
const CONSOLE_ACTOR_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_CONSOLE_ACTORS = 256;
const DEFAULT_MAX_CONSOLE_REQUESTS_PER_ACTOR_PER_WINDOW = 120;
const DEFAULT_MAX_CONSOLE_REQUESTS_PER_WINDOW = 600;
const DEFAULT_MAX_CONSOLE_STREAMS = 64;
const DEFAULT_MAX_CONSOLE_STREAMS_PER_ACTOR = 4;
const DEFAULT_CONSOLE_REQUEST_RATE_WINDOW_MS = 10_000;
const STREAM_RESERVATION_TTL_MS = 5_000;
const MAX_WS_BUFFERED_BYTES = 1024 * 1024;
const STREAM_WAIT_MS = 1_000;
const STREAM_EVENT_LIMIT = 100;

const identitySchema = z.strictObject({
  generation: z.number().int().positive(),
});
const sessionParamsSchema = z.strictObject({ sessionId: z.string().min(1).max(256) });
const approvalParamsSchema = sessionParamsSchema.extend({
  approvalId: z.string().min(1).max(256),
});
const createSessionSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(256),
  shell: z.enum(["bash", "zsh"]),
  workspaceRoot: z.string().min(1).max(4_096),
});
const executeSchema = identitySchema.extend({
  approvalId: z.string().min(1).max(256).optional(),
  command: z
    .string()
    .min(1)
    .max(256 * 1_024),
  idempotencyKey: z.string().min(1).max(256),
});
const approvalListSchema = z.strictObject({
  generation: z.coerce.number().int().positive(),
  status: z.enum(["PENDING", "APPROVED", "DENIED", "EXPIRED", "CONSUMED"]).optional(),
});
const approvalDecisionSchema = identitySchema.extend({
  decision: z.enum(["approve", "deny"]),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(256),
  reason: z.string().min(1).max(512),
});
const forkSessionSchema = identitySchema.extend({
  allowStale: z.boolean(),
  expectedCheckpointVersion: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(256),
});
const inputSchema = identitySchema.extend({
  data: z
    .string()
    .min(1)
    .max(64 * 1_024),
  expectedScreenVersion: z.number().int().nonnegative().optional(),
  lineInput: z
    .strictObject({
      expectedInputVersion: z.number().int().nonnegative(),
      expectedInteractionVersion: z.number().int().positive(),
    })
    .optional(),
  idempotencyKey: z.string().min(1).max(256),
  targetExecutionId: z.string().min(1).max(256),
});
const secretInputSchema = identitySchema.extend({
  data: z
    .string()
    .min(1)
    .max(64 * 1_024),
  expectedScreenVersion: z.number().int().nonnegative().optional(),
  idempotencyKey: z.string().min(1).max(256),
  targetExecutionId: z.string().min(1).max(256),
});
const finishSecretInputSchema = identitySchema.extend({
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(256),
  outcome: z.enum(["completed", "cancelled"]),
});
const sensitiveInputParamsSchema = sessionParamsSchema.extend({
  sensitiveInputId: z.string().min(1).max(256),
});
const controlSchema = identitySchema.extend({
  bypassGuard: z.boolean().default(false),
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
  idempotencyKey: z.string().min(1).max(256),
  targetExecutionId: z.string().min(1).max(256),
});
const interactionPolicySchema = identitySchema.extend({
  expectedVersion: z.number().int().positive(),
  mode: z.enum(["common", "human_guarded", "human_only", "agent_only"]),
});
const acquireGuardSchema = identitySchema.extend({
  expectedVersion: z.number().int().positive(),
  reason: z.string().min(1).max(256),
  ttlMilliseconds: z.number().int().min(50).max(5_000).optional(),
});
const renewGuardSchema = identitySchema.extend({
  expectedVersion: z.number().int().positive(),
  guardId: z.string().min(1).max(256),
  ttlMilliseconds: z.number().int().min(50).max(5_000).optional(),
});
const releaseGuardSchema = identitySchema.extend({
  expectedVersion: z.number().int().positive(),
  guardId: z.string().min(1).max(256),
});
const resizeSchema = identitySchema.extend({
  columns: z.number().int().min(MIN_TERMINAL_COLUMNS).max(MAX_TERMINAL_COLUMNS),
  expectedGeometryVersion: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(256),
  rows: z.number().int().min(MIN_TERMINAL_ROWS).max(MAX_TERMINAL_ROWS),
});
const eventQuerySchema = z.strictObject({
  after: z.coerce.number().int().nonnegative().default(0),
  generation: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const streamQuerySchema = z.strictObject({
  after: z.coerce.number().int().nonnegative().default(0),
  afterScreenVersion: z.coerce.number().int().nonnegative().optional(),
  generation: z.coerce.number().int().positive(),
});
const streamAckSchema = z.strictObject({
  cursor: z.number().int().nonnegative(),
  screenVersion: z.number().int().nonnegative(),
  type: z.literal("ack"),
});

interface ConsoleActorRecord {
  readonly actor: Actor;
  lastSeenAt: number;
}

export interface HumanConsoleServerOptions {
  readonly gateway: RuntimeGateway;
  readonly host?: string;
  readonly logger?: boolean;
  readonly mcpConfigPath?: string;
  readonly now?: () => number;
  readonly port?: number;
  readonly resourceLimits?: Partial<HumanConsoleResourceLimits>;
  readonly staticRoot?: string;
}

export interface HumanConsoleResourceLimits {
  readonly maxActors: number;
  readonly maxRequestsPerActorPerWindow: number;
  readonly maxRequestsPerWindow: number;
  readonly maxStreams: number;
  readonly maxStreamsPerActor: number;
  readonly requestRateWindowMilliseconds: number;
}

export interface HumanConsoleServerHandle {
  readonly app: FastifyInstance;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export async function createHumanConsoleApp(
  options: HumanConsoleServerOptions,
): Promise<FastifyInstance> {
  const now = options.now ?? Date.now;
  const expectedHost = normalizeHostname(options.host ?? "127.0.0.1");
  const limits = consoleResourceLimits(options.resourceLimits);
  const actors = new Map<string, ConsoleActorRecord>();
  const openSessionStreams = new Map<string, number>();
  const pendingStreamAdmissions = new WeakMap<object, ConsoleStreamReservation>();
  const streamAdmissions = new ConsoleStreamAdmissions(limits);
  const requestRates = new ConsoleRequestRates(limits, now);
  const mcpConfigJson =
    options.mcpConfigPath === undefined
      ? undefined
      : await readMcpConfiguration(options.mcpConfigPath);
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger: options.logger ?? false,
  });

  await app.register(fastifyWebsocket, {
    options: { maxPayload: 16 * 1_024 },
  });

  app.addHook("onRequest", async (request, reply) => {
    applySecurityHeaders(reply);
    const authority = validateHost(request, expectedHost, options.port);
    const isWebSocket = request.headers.upgrade?.toLowerCase() === "websocket";
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    validateBrowserFetchSite(request);
    if (isWebSocket || mutating) validateSameOrigin(request, authority);
    if (
      request.raw.url?.startsWith("/api") === true &&
      !isWebSocket &&
      request.headers["x-iterminal-request"] !== "console"
    ) {
      throw new ConsoleHttpError(403, "INVALID_REQUEST", "Missing Console request header");
    }
    if (request.raw.url?.startsWith("/api") === true) {
      requestRates.admit(knownActorId(request, actors));
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ConsoleHttpError && error.code === "RATE_LIMITED") {
      const retryAfterMilliseconds = error.details.retryAfterMilliseconds;
      if (typeof retryAfterMilliseconds === "number") {
        reply.header("retry-after", Math.max(1, Math.ceil(retryAfterMilliseconds / 1_000)));
      }
    }
    const envelope = errorEnvelope(error, request.id);
    void reply.status(envelope.status).send({ error: envelope.error });
  });

  app.get("/api/bootstrap", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now, true, limits.maxActors);
    const sessions = await options.gateway.listSessions();
    return success(request, {
      actor,
      canonicalGeometry: {
        columns: CANONICAL_TERMINAL_COLUMNS,
        rows: CANONICAL_TERMINAL_ROWS,
      },
      geometryBounds: {
        maxColumns: MAX_TERMINAL_COLUMNS,
        maxRows: MAX_TERMINAL_ROWS,
        minColumns: MIN_TERMINAL_COLUMNS,
        minRows: MIN_TERMINAL_ROWS,
      },
      ...(mcpConfigJson === undefined
        ? {}
        : {
            mcpConnection: {
              configJson: mcpConfigJson,
              serverName: "iterminal",
            },
          }),
      sessions,
    });
  });

  app.get("/api/sessions", async (request, reply) => {
    actorForRequest(request, reply, actors, now);
    return success(request, await options.gateway.listSessions());
  });

  app.post("/api/sessions", async (request, reply) => {
    actorForRequest(request, reply, actors, now);
    const body = createSessionSchema.parse(request.body);
    const session = await options.gateway.createSession(body);
    return reply.status(201).send(success(request, session));
  });

  app.get("/api/sessions/:sessionId", async (request, reply) => {
    actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    return success(request, await options.gateway.getSession(sessionId));
  });

  app.get("/api/sessions/:sessionId/checkpoint", async (request, reply) => {
    actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const { generation } = eventQuerySchema.pick({ generation: true }).parse(request.query);
    return success(request, await options.gateway.getSessionCheckpoint(sessionId, generation));
  });

  app.post("/api/sessions/:sessionId/fork", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const body = forkSessionSchema.parse(request.body);
    return reply.status(201).send(
      success(
        request,
        await options.gateway.forkSession({
          actor,
          allowStale: body.allowStale,
          expectedCheckpointVersion: body.expectedCheckpointVersion,
          idempotencyKey: body.idempotencyKey,
          sessionGeneration: body.generation,
          sessionId,
        }),
      ),
    );
  });

  app.delete("/api/sessions/:sessionId", async (request, reply) => {
    actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const { generation } = identitySchema.parse(request.body);
    return success(request, await options.gateway.closeSession(sessionId, generation));
  });

  app.post("/api/sessions/:sessionId/execute", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const body = executeSchema.parse(request.body);
    return reply.status(202).send(
      success(
        request,
        await options.gateway.startExecute({
          actor,
          ...(body.approvalId === undefined ? {} : { approvalId: body.approvalId }),
          command: body.command,
          idempotencyKey: body.idempotencyKey,
          sessionGeneration: body.generation,
          sessionId,
        }),
      ),
    );
  });

  app.get("/api/sessions/:sessionId/approvals", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const query = approvalListSchema.parse(request.query);
    return success(
      request,
      await options.gateway.listApprovals({
        actor,
        sessionGeneration: query.generation,
        sessionId,
        ...(query.status === undefined ? {} : { status: query.status }),
      }),
    );
  });

  app.get("/api/sessions/:sessionId/approvals/:approvalId", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { approvalId, sessionId } = approvalParamsSchema.parse(request.params);
    const { generation } = approvalListSchema.pick({ generation: true }).parse(request.query);
    return success(
      request,
      await options.gateway.getApproval({
        actor,
        approvalId,
        sessionGeneration: generation,
        sessionId,
      }),
    );
  });

  app.post("/api/sessions/:sessionId/approvals/:approvalId/decision", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { approvalId, sessionId } = approvalParamsSchema.parse(request.params);
    const body = approvalDecisionSchema.parse(request.body);
    return success(
      request,
      await options.gateway.decideApproval({
        actor,
        approvalId,
        decision: body.decision,
        expectedVersion: body.expectedVersion,
        idempotencyKey: body.idempotencyKey,
        reason: body.reason,
        sessionGeneration: body.generation,
        sessionId,
      }),
    );
  });

  app.post("/api/sessions/:sessionId/input", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const body = inputSchema.parse(request.body);
    return reply.status(202).send(
      success(
        request,
        await options.gateway.sendInput({
          actor,
          data: body.data,
          ...(body.lineInput === undefined ? {} : { lineInput: body.lineInput }),
          idempotencyKey: body.idempotencyKey,
          sessionGeneration: body.generation,
          sessionId,
          targetExecutionId: body.targetExecutionId,
          ...(body.expectedScreenVersion === undefined
            ? {}
            : { expectedScreenVersion: body.expectedScreenVersion }),
        }),
      ),
    );
  });

  app.get("/api/sessions/:sessionId/secret-input", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const { generation } = eventQuerySchema.pick({ generation: true }).parse(request.query);
    return success(
      request,
      await options.gateway.getSensitiveInput({
        actor,
        sessionGeneration: generation,
        sessionId,
      }),
    );
  });

  app.post("/api/sessions/:sessionId/secret-input", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const body = secretInputSchema.parse(request.body);
    await requireRunningTarget(options.gateway, sessionId, body.generation, body.targetExecutionId);
    return reply.status(202).send(
      success(
        request,
        await options.gateway.beginSecretInput({
          actor,
          data: body.data,
          idempotencyKey: body.idempotencyKey,
          sessionGeneration: body.generation,
          sessionId,
          targetExecutionId: body.targetExecutionId,
          ...(body.expectedScreenVersion === undefined
            ? {}
            : { expectedScreenVersion: body.expectedScreenVersion }),
        }),
      ),
    );
  });

  app.post(
    "/api/sessions/:sessionId/secret-input/:sensitiveInputId/finish",
    async (request, reply) => {
      const actor = actorForRequest(request, reply, actors, now);
      const { sensitiveInputId, sessionId } = sensitiveInputParamsSchema.parse(request.params);
      const body = finishSecretInputSchema.parse(request.body);
      return success(
        request,
        await options.gateway.finishSensitiveInput({
          actor,
          expectedVersion: body.expectedVersion,
          idempotencyKey: body.idempotencyKey,
          outcome: body.outcome,
          sensitiveInputId,
          sessionGeneration: body.generation,
          sessionId,
        }),
      );
    },
  );

  app.post("/api/sessions/:sessionId/control", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const body = controlSchema.parse(request.body);
    return reply.status(202).send(
      success(
        request,
        await options.gateway.sendControl({
          actor,
          bypassGuard: body.bypassGuard,
          delivery: body.delivery,
          idempotencyKey: body.idempotencyKey,
          sessionGeneration: body.generation,
          sessionId,
          targetExecutionId: body.targetExecutionId,
        }),
      ),
    );
  });

  app.post("/api/sessions/:sessionId/resize", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const body = resizeSchema.parse(request.body);
    return reply.status(202).send(
      success(
        request,
        await options.gateway.resizeTerminal({
          actor,
          columns: body.columns,
          expectedGeometryVersion: body.expectedGeometryVersion,
          idempotencyKey: body.idempotencyKey,
          rows: body.rows,
          sessionGeneration: body.generation,
          sessionId,
        }),
      ),
    );
  });

  app.get("/api/sessions/:sessionId/events", async (request, reply) => {
    actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const query = eventQuerySchema.parse(request.query);
    return success(
      request,
      await options.gateway.queryEvents(sessionId, query.generation, query.after, query.limit),
    );
  });

  app.get("/api/sessions/:sessionId/screen", async (request, reply) => {
    actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const { generation } = eventQuerySchema.pick({ generation: true }).parse(request.query);
    return success(request, await options.gateway.getScreen(sessionId, generation));
  });

  app.get("/api/sessions/:sessionId/interaction", async (request, reply) => {
    actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const { generation } = eventQuerySchema.pick({ generation: true }).parse(request.query);
    return success(request, await options.gateway.getInteractionState(sessionId, generation));
  });

  app.put("/api/sessions/:sessionId/interaction", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const body = interactionPolicySchema.parse(request.body);
    return success(
      request,
      await options.gateway.setInputPolicy({
        actor,
        expectedVersion: body.expectedVersion,
        mode: body.mode,
        sessionGeneration: body.generation,
        sessionId,
      }),
    );
  });

  app.post("/api/sessions/:sessionId/interaction/guard", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const body = acquireGuardSchema.parse(request.body);
    return reply.status(201).send(
      success(
        request,
        await options.gateway.acquireInteractionGuard({
          actor,
          expectedVersion: body.expectedVersion,
          reason: body.reason,
          sessionGeneration: body.generation,
          sessionId,
          ...(body.ttlMilliseconds === undefined ? {} : { ttlMilliseconds: body.ttlMilliseconds }),
        }),
      ),
    );
  });

  app.patch("/api/sessions/:sessionId/interaction/guard", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const body = renewGuardSchema.parse(request.body);
    return success(
      request,
      await options.gateway.renewInteractionGuard({
        actor,
        expectedVersion: body.expectedVersion,
        guardId: body.guardId,
        sessionGeneration: body.generation,
        sessionId,
        ...(body.ttlMilliseconds === undefined ? {} : { ttlMilliseconds: body.ttlMilliseconds }),
      }),
    );
  });

  app.delete("/api/sessions/:sessionId/interaction/guard", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const body = releaseGuardSchema.parse(request.body);
    return success(
      request,
      await options.gateway.releaseInteractionGuard({
        actor,
        expectedVersion: body.expectedVersion,
        guardId: body.guardId,
        sessionGeneration: body.generation,
        sessionId,
      }),
    );
  });

  app.get(
    "/api/sessions/:sessionId/stream",
    {
      preValidation: (request, reply, done) => {
        const actor = actorForRequest(request, reply, actors, now);
        sessionParamsSchema.parse(request.params);
        streamQuerySchema.parse(request.query);
        pendingStreamAdmissions.set(request.raw, streamAdmissions.reserve(actor));
        done();
      },
      websocket: true,
    },
    (socket, request) => {
      const reservation = pendingStreamAdmissions.get(request.raw);
      pendingStreamAdmissions.delete(request.raw);
      const releaseStream = reservation?.consume();
      if (reservation === undefined || releaseStream === undefined) {
        socket.close(1013, "stream admission expired");
        return;
      }
      const actor = reservation.actor;
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const query = streamQuerySchema.parse(request.query);
      const streamKey = `${actor.id}:${sessionId}:${query.generation.toString()}`;
      openSessionStreams.set(streamKey, (openSessionStreams.get(streamKey) ?? 0) + 1);
      socket.once("close", () => {
        releaseStream();
        const remaining = (openSessionStreams.get(streamKey) ?? 1) - 1;
        if (remaining <= 0) {
          openSessionStreams.delete(streamKey);
          void releaseActorGuard(options.gateway, actor, sessionId, query.generation);
        } else {
          openSessionStreams.set(streamKey, remaining);
        }
      });
      void streamSession(socket, options.gateway, actor, sessionId, query).catch(() => {
        socket.terminate();
      });
    },
  );

  const staticRoot = options.staticRoot ?? resolve(process.cwd(), "dist/console-web");
  if (existsSync(staticRoot)) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      wildcard: true,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/")) {
        void reply.status(404).send({
          error: {
            allowedNextActions: [],
            code: "SESSION_NOT_FOUND",
            details: {},
            message: "Console API route not found",
            requestId: request.id,
            retryable: false,
          },
        });
        return;
      }
      if (request.raw.url?.startsWith("/assets/") === true) {
        void reply.status(404).type("text/plain").send("Console asset not found");
        return;
      }
      void reply.type("text/html").sendFile("index.html");
    });
  }

  return app;
}

async function readMcpConfiguration(path: string): Promise<string> {
  const source = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MCP configuration must be a JSON object");
  }
  return JSON.stringify(parsed, null, 2);
}

export async function startHumanConsole(
  options: HumanConsoleServerOptions,
): Promise<HumanConsoleServerHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHostname(host)) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "Human Console must listen on loopback until remote authentication exists",
      { host },
    );
  }
  const app = await createHumanConsoleApp(options);
  await app.listen({ host, port: options.port ?? 4173 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    await app.close();
    throw new RuntimeError("RUNTIME_UNAVAILABLE", "Human Console did not obtain a TCP listener");
  }
  const port = address.port;
  const displayHost = host.includes(":") ? `[${host}]` : host;
  return {
    app,
    host,
    port,
    url: `http://${displayHost}:${port.toString()}`,
    close: () => app.close(),
  };
}

async function streamSession(
  socket: WebSocket,
  gateway: RuntimeGateway,
  actor: Actor,
  sessionId: string,
  initial: z.infer<typeof streamQuerySchema>,
): Promise<void> {
  let cursor = initial.after;
  let closed = false;
  const abort = new AbortController();
  socket.once("close", () => {
    closed = true;
    abort.abort();
  });
  socket.on("message", (raw) => {
    try {
      streamAckSchema.parse(JSON.parse(rawDataText(raw)) as unknown);
    } catch {
      sendSocket(socket, {
        error: { code: "INVALID_REQUEST", message: "Malformed stream acknowledgement" },
        type: "error",
      });
      socket.close(1008, "malformed acknowledgement");
    }
  });

  try {
    const first = await readSyncBundle(gateway, sessionId, initial.generation, cursor);
    cursor = first.cursor;
    const priorScreenVersion = initial.afterScreenVersion;
    let screenVersion = first.screen.screenVersion;
    let drainEvents = first.truncated;
    sendSocket(socket, {
      ...first,
      actor,
      liveGap:
        priorScreenVersion === undefined || priorScreenVersion === first.screen.screenVersion
          ? undefined
          : {
              fromScreenVersion: priorScreenVersion,
              reason: "full_screen_resync",
              toScreenVersion: first.screen.screenVersion,
            },
      type: "sync",
    });

    while (!closed) {
      const nextScreen = drainEvents
        ? await gateway.getScreen(sessionId, initial.generation)
        : (
            await gateway.waitForScreen(
              {
                condition: { afterVersion: screenVersion, type: "version" },
                generation: initial.generation,
                sessionId,
                timeoutMilliseconds: STREAM_WAIT_MS,
              },
              abort.signal,
            )
          ).snapshot;
      if (closed) return;
      const events = await gateway.queryEvents(
        sessionId,
        initial.generation,
        cursor,
        STREAM_EVENT_LIMIT,
      );
      cursor = eventCursor(events, cursor);
      const interaction = await gateway.getInteractionState(sessionId, initial.generation);
      const session = await gateway.getSession(sessionId);
      screenVersion = nextScreen.screenVersion;
      drainEvents = events.truncated;
      sendSocket(socket, {
        cursor,
        events: events.events,
        interaction,
        screen: nextScreen,
        session,
        truncated: events.truncated,
        type: "update",
      });
      if (drainEvents) continue;
      if (session.status === "BROKEN" || session.status === "CLOSED") {
        socket.close(1000, "session ended");
        return;
      }
    }
  } catch (error) {
    if (closed || abort.signal.aborted) return;
    const envelope = errorEnvelope(error, `ws_${randomUUID()}`);
    const resync = envelope.error.code === "RESYNC_REQUIRED";
    sendSocket(socket, {
      error: envelope.error,
      type: resync ? "resync_required" : "error",
    });
    socket.close(resync ? 1012 : 1011, resync ? "resync required" : "stream failed");
  }
}

async function readSyncBundle(
  gateway: RuntimeGateway,
  sessionId: string,
  generation: number,
  after: number,
): Promise<{
  readonly cursor: number;
  readonly eventGap?: Readonly<Record<string, unknown>>;
  readonly events: EventPage["events"];
  readonly interaction: InteractionState;
  readonly screen: Awaited<ReturnType<RuntimeGateway["getScreen"]>>;
  readonly session: Session;
  readonly truncated: boolean;
}> {
  const [session, interaction, screen] = await Promise.all([
    gateway.getSession(sessionId),
    gateway.getInteractionState(sessionId, generation),
    gateway.getScreen(sessionId, generation),
  ]);
  let events: EventPage;
  let eventCursorBase = after;
  let eventGap: Readonly<Record<string, unknown>> | undefined;
  try {
    events = await gateway.queryEvents(sessionId, generation, after, STREAM_EVENT_LIMIT);
  } catch (error) {
    if (!(error instanceof RuntimeError) || error.code !== "RESYNC_REQUIRED") throw error;
    eventGap = { fromCursor: after, reason: error.message, ...error.details };
    eventCursorBase = 0;
    events = await gateway.queryEvents(sessionId, generation, 0, STREAM_EVENT_LIMIT);
  }
  return {
    cursor: eventCursor(events, eventCursorBase),
    ...(eventGap === undefined ? {} : { eventGap }),
    events: events.events,
    interaction,
    screen,
    session,
    truncated: events.truncated,
  };
}

function sendSocket(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  if (socket.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
    socket.send(
      JSON.stringify({
        reason: "slow_consumer",
        type: "resync_required",
      }),
    );
    socket.close(1013, "slow consumer");
    return;
  }
  socket.send(JSON.stringify(value));
}

function eventCursor(page: EventPage, previous: number): number {
  return page.events.at(-1)?.sequence ?? previous;
}

function rawDataText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

async function requireRunningTarget(
  gateway: RuntimeGateway,
  sessionId: string,
  generation: number,
  targetExecutionId: string,
): Promise<void> {
  const session = await gateway.getSession(sessionId);
  if (
    session.generation !== generation ||
    session.status !== "RUNNING" ||
    session.activeExecutionId !== targetExecutionId
  ) {
    throw modeError(session, generation, "Input and Control require RUNNING interactive mode");
  }
}

function modeError(session: Session, generation: number, message: string): RuntimeError {
  if (session.generation !== generation) {
    return new RuntimeError("SESSION_GENERATION_CHANGED", message, {
      currentGeneration: session.generation,
      requestedGeneration: generation,
      sessionId: session.id,
    });
  }
  return new RuntimeError("SESSION_NOT_READY", message, {
    activeExecutionId: session.activeExecutionId,
    sessionId: session.id,
    status: session.status,
  });
}

async function releaseActorGuard(
  gateway: RuntimeGateway,
  actor: Actor,
  sessionId: string,
  generation: number,
): Promise<void> {
  try {
    const state = await gateway.getInteractionState(sessionId, generation);
    if (state.guard === undefined || !sameActor(state.guard.actor, actor)) return;
    await gateway.releaseInteractionGuard({
      actor,
      expectedVersion: state.version,
      guardId: state.guard.id,
      sessionGeneration: generation,
      sessionId,
    });
  } catch {
    // TTL is the safety boundary when disconnect cleanup races with state changes.
  }
}

function actorForRequest(
  request: FastifyRequest,
  reply: FastifyReply | undefined,
  actors: Map<string, ConsoleActorRecord>,
  now: () => number,
  create = false,
  maxActors = DEFAULT_MAX_CONSOLE_ACTORS,
): Actor {
  pruneActors(actors, now());
  const cookieId = parseCookies(request.headers.cookie)[CONSOLE_COOKIE];
  const current = cookieId === undefined ? undefined : actors.get(cookieId);
  if (current !== undefined) {
    current.lastSeenAt = now();
    return current.actor;
  }
  if (!create || reply === undefined) {
    throw new ConsoleHttpError(401, "POLICY_DENIED", "Console session cookie is required");
  }
  if (actors.size >= maxActors) {
    throw new ConsoleHttpError(503, "BACKPRESSURE", "Console Actor capacity is exhausted", true);
  }
  const id = isConsoleActorCookieId(cookieId) ? cookieId : randomUUID();
  const actor: Actor = {
    capabilities: ACTOR_CAPABILITY_PROFILES.human,
    client: "human-console-web",
    id: `human_console_${id}`,
    principal: `local-console:${id}`,
    type: "human",
  };
  actors.set(id, { actor, lastSeenAt: now() });
  reply.header(
    "set-cookie",
    `${CONSOLE_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
  );
  return actor;
}

function isConsoleActorCookieId(value: string | undefined): value is string {
  return (
    value !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function knownActorId(
  request: FastifyRequest,
  actors: ReadonlyMap<string, ConsoleActorRecord>,
): string | undefined {
  const cookieId = parseCookies(request.headers.cookie)[CONSOLE_COOKIE];
  return cookieId !== undefined && actors.has(cookieId) ? cookieId : undefined;
}

function pruneActors(actors: Map<string, ConsoleActorRecord>, currentTime: number): void {
  for (const [id, record] of actors) {
    if (record.lastSeenAt + CONSOLE_ACTOR_TTL_MS <= currentTime) actors.delete(id);
  }
}

function parseCookies(header: string | undefined): Readonly<Record<string, string>> {
  if (header === undefined) return {};
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("=", 2))
      .filter(
        (pair): pair is [string, string] =>
          pair.length === 2 && (pair[0]?.length ?? 0) > 0 && pair[1] !== undefined,
      )
      .map(([name, value]) => [name, decodeCookieValue(value)]),
  );
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

interface ConsoleRequestAuthority {
  readonly hostname: string;
  readonly port: number;
  readonly protocol: "http" | "https";
}

function validateHost(
  request: FastifyRequest,
  expectedHost: string,
  configuredPort: number | undefined,
): ConsoleRequestAuthority {
  const host = request.headers.host;
  if (host === undefined) throw new ConsoleHttpError(400, "INVALID_REQUEST", "Host is required");
  const protocol = request.protocol;
  if (protocol !== "http" && protocol !== "https") {
    throw new ConsoleHttpError(403, "POLICY_DENIED", "Console request protocol is invalid");
  }
  const parsed = parseAuthority(host, protocol);
  const hostname = parsed.hostname;
  if (!isLoopbackHostname(hostname)) {
    throw new ConsoleHttpError(403, "POLICY_DENIED", "Console Host must resolve to loopback");
  }
  if (hostname !== expectedHost) {
    throw new ConsoleHttpError(403, "POLICY_DENIED", "Console Host does not match listener");
  }
  const localPort = request.socket.localPort ?? configuredPort;
  if (localPort === undefined || localPort === 0 || parsed.port !== localPort) {
    throw new ConsoleHttpError(403, "POLICY_DENIED", "Console Host port does not match listener");
  }
  return { hostname, port: parsed.port, protocol };
}

function validateSameOrigin(request: FastifyRequest, authority: ConsoleRequestAuthority): void {
  const origin = request.headers.origin;
  if (origin === undefined) {
    throw new ConsoleHttpError(403, "POLICY_DENIED", "Same-origin Console request required");
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ConsoleHttpError(403, "POLICY_DENIED", "Console Origin is invalid");
  }
  const hostname = normalizeHostname(parsed.hostname);
  const protocol = parsed.protocol.slice(0, -1);
  const cleanOrigin =
    origin === parsed.origin &&
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    parsed.pathname === "/" &&
    parsed.search.length === 0 &&
    parsed.hash.length === 0;
  const port = effectivePort(parsed.port, protocol);
  if (
    !cleanOrigin ||
    protocol !== authority.protocol ||
    hostname !== authority.hostname ||
    port !== authority.port ||
    !isLoopbackHostname(hostname)
  ) {
    throw new ConsoleHttpError(403, "POLICY_DENIED", "Console Origin does not match Host");
  }
}

function validateBrowserFetchSite(request: FastifyRequest): void {
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "none" && fetchSite !== "same-origin") {
    throw new ConsoleHttpError(403, "POLICY_DENIED", "Cross-site Console request denied");
  }
}

function parseAuthority(
  authority: string,
  protocol: "http" | "https",
): Readonly<{ hostname: string; port: number }> {
  if (
    authority.trim() !== authority ||
    authority.length === 0 ||
    authority.includes("@") ||
    /[\\/?#]/u.test(authority)
  ) {
    throw new ConsoleHttpError(400, "INVALID_REQUEST", "Host is malformed");
  }
  try {
    const parsed = new URL(`${protocol}://${authority}`);
    if (
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new Error("authority has URL components");
    }
    const port = effectivePort(parsed.port, protocol);
    if (port === undefined) throw new Error("authority protocol is unsupported");
    return {
      hostname: normalizeHostname(parsed.hostname),
      port,
    };
  } catch {
    throw new ConsoleHttpError(400, "INVALID_REQUEST", "Host is malformed");
  }
}

function effectivePort(port: string, protocol: string): number | undefined {
  if (port.length > 0) return Number.parseInt(port, 10);
  if (protocol === "http") return 80;
  if (protocol === "https") return 443;
  return undefined;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/gu, "").toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function consoleResourceLimits(
  configured: Partial<HumanConsoleResourceLimits> | undefined,
): HumanConsoleResourceLimits {
  const limits = {
    maxActors: configured?.maxActors ?? DEFAULT_MAX_CONSOLE_ACTORS,
    maxRequestsPerActorPerWindow:
      configured?.maxRequestsPerActorPerWindow ?? DEFAULT_MAX_CONSOLE_REQUESTS_PER_ACTOR_PER_WINDOW,
    maxRequestsPerWindow:
      configured?.maxRequestsPerWindow ?? DEFAULT_MAX_CONSOLE_REQUESTS_PER_WINDOW,
    maxStreams: configured?.maxStreams ?? DEFAULT_MAX_CONSOLE_STREAMS,
    maxStreamsPerActor: configured?.maxStreamsPerActor ?? DEFAULT_MAX_CONSOLE_STREAMS_PER_ACTOR,
    requestRateWindowMilliseconds:
      configured?.requestRateWindowMilliseconds ?? DEFAULT_CONSOLE_REQUEST_RATE_WINDOW_MS,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RuntimeError("INVALID_REQUEST", `${name} must be a positive safe integer`);
    }
  }
  if (limits.maxStreamsPerActor > limits.maxStreams) {
    throw new RuntimeError("INVALID_REQUEST", "maxStreamsPerActor cannot exceed maxStreams");
  }
  if (limits.maxRequestsPerActorPerWindow > limits.maxRequestsPerWindow) {
    throw new RuntimeError(
      "INVALID_REQUEST",
      "maxRequestsPerActorPerWindow cannot exceed maxRequestsPerWindow",
    );
  }
  return limits;
}

interface ConsoleRateWindow {
  count: number;
  startedAt: number;
}

class ConsoleRequestRates {
  readonly #byActor = new Map<string, ConsoleRateWindow>();
  #global: ConsoleRateWindow | undefined;

  public constructor(
    private readonly limits: HumanConsoleResourceLimits,
    private readonly now: () => number,
  ) {}

  public admit(actorId: string | undefined): void {
    const currentTime = this.now();
    this.#prune(currentTime);
    const global = this.#window(this.#global, currentTime);
    this.#global = global;
    const actorKey = actorId ?? "anonymous";
    const actor = this.#window(this.#byActor.get(actorKey), currentTime);
    this.#byActor.set(actorKey, actor);
    if (global.count >= this.limits.maxRequestsPerWindow) {
      throw this.#limited("console", global, currentTime);
    }
    if (actor.count >= this.limits.maxRequestsPerActorPerWindow) {
      throw this.#limited("actor", actor, currentTime);
    }
    global.count += 1;
    actor.count += 1;
  }

  #window(current: ConsoleRateWindow | undefined, currentTime: number): ConsoleRateWindow {
    if (
      current === undefined ||
      current.startedAt + this.limits.requestRateWindowMilliseconds <= currentTime
    ) {
      return { count: 0, startedAt: currentTime };
    }
    return current;
  }

  #limited(scope: "actor" | "console", window: ConsoleRateWindow, currentTime: number): Error {
    const retryAfterMilliseconds = Math.max(
      1,
      window.startedAt + this.limits.requestRateWindowMilliseconds - currentTime,
    );
    return new ConsoleHttpError(
      429,
      "RATE_LIMITED",
      scope === "actor"
        ? "Console Actor request rate is exhausted"
        : "Console request rate is exhausted",
      true,
      { retryAfterMilliseconds, scope },
    );
  }

  #prune(currentTime: number): void {
    for (const [actorId, window] of this.#byActor) {
      if (window.startedAt + this.limits.requestRateWindowMilliseconds <= currentTime) {
        this.#byActor.delete(actorId);
      }
    }
  }
}

interface ConsoleStreamReservation {
  readonly actor: Actor;
  consume(): (() => void) | undefined;
}

class ConsoleStreamAdmissions {
  readonly #byActor = new Map<string, number>();
  #total = 0;

  public constructor(private readonly limits: HumanConsoleResourceLimits) {}

  public reserve(actor: Actor): ConsoleStreamReservation {
    if (this.#total >= this.limits.maxStreams) {
      throw new ConsoleHttpError(
        503,
        "BACKPRESSURE",
        "Console stream capacity is exhausted",
        true,
        { scope: "console" },
      );
    }
    const actorStreams = this.#byActor.get(actor.id) ?? 0;
    if (actorStreams >= this.limits.maxStreamsPerActor) {
      throw new ConsoleHttpError(
        503,
        "BACKPRESSURE",
        "Console Actor stream capacity is exhausted",
        true,
        { scope: "actor" },
      );
    }
    this.#total += 1;
    this.#byActor.set(actor.id, actorStreams + 1);
    let held = true;
    const release = (): void => {
      if (!held) return;
      held = false;
      this.#total -= 1;
      const remaining = (this.#byActor.get(actor.id) ?? 1) - 1;
      if (remaining <= 0) this.#byActor.delete(actor.id);
      else this.#byActor.set(actor.id, remaining);
    };
    const timeout = setTimeout(release, STREAM_RESERVATION_TTL_MS);
    timeout.unref();
    return {
      actor,
      consume: () => {
        if (!held) return undefined;
        clearTimeout(timeout);
        return release;
      },
    };
  }
}

function applySecurityHeaders(reply: FastifyReply): void {
  reply.headers({
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
}

function success(request: FastifyRequest, result: unknown): Readonly<Record<string, unknown>> {
  return { requestId: request.id, result };
}

function errorEnvelope(
  error: unknown,
  requestId: string,
): Readonly<{
  error: Readonly<Record<string, unknown>>;
  status: number;
}> {
  if (isFastifyBodyTooLarge(error)) {
    return {
      error: {
        allowedNextActions: [],
        code: "INVALID_REQUEST",
        details: {},
        message: "Console request body exceeds the configured limit",
        requestId,
        retryable: false,
      },
      status: 413,
    };
  }
  if (isFastifyInvalidJson(error)) {
    return {
      error: {
        allowedNextActions: [],
        code: "INVALID_REQUEST",
        details: {},
        message: "Console request body is not valid JSON",
        requestId,
        retryable: false,
      },
      status: 400,
    };
  }
  if (error instanceof ConsoleHttpError) {
    return {
      error: {
        allowedNextActions: allowedNextActions(error.code),
        code: error.code,
        details: error.details,
        message: error.message,
        requestId,
        retryable: error.retryable,
      },
      status: error.status,
    };
  }
  if (error instanceof RuntimeError) {
    return {
      error: {
        allowedNextActions: allowedNextActions(error.code),
        code: error.code,
        details: error.details,
        message: error.message,
        requestId,
        retryable: error.retryable,
      },
      status: runtimeStatus(error.code),
    };
  }
  if (error instanceof z.ZodError) {
    return {
      error: {
        allowedNextActions: [],
        code: "INVALID_REQUEST",
        details: {},
        message: "Console request validation failed",
        requestId,
        retryable: false,
      },
      status: 400,
    };
  }
  return {
    error: {
      allowedNextActions: ["reconnect_console", "inspect_runtime_health"],
      code: "RUNTIME_UNAVAILABLE",
      details: {},
      message: "Console request failed",
      requestId,
      retryable: true,
    },
    status: 500,
  };
}

function isFastifyBodyTooLarge(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: unknown }).code === "FST_ERR_CTP_BODY_TOO_LARGE"
  );
}

function isFastifyInvalidJson(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: unknown }).code === "FST_ERR_CTP_INVALID_JSON_BODY"
  );
}

function runtimeStatus(code: RuntimeError["code"]): number {
  switch (code) {
    case "SESSION_NOT_FOUND":
    case "EXECUTION_NOT_FOUND":
      return 404;
    case "POLICY_DENIED":
      return 403;
    case "APPROVAL_NOT_FOUND":
      return 404;
    case "INPUT_GUARDED":
      return 423;
    case "BACKPRESSURE":
    case "RATE_LIMITED":
      return 429;
    case "RUNTIME_UNAVAILABLE":
      return 503;
    case "INVALID_REQUEST":
      return 400;
    default:
      return 409;
  }
}

function allowedNextActions(code: string): readonly string[] {
  switch (code) {
    case "PTY_BUSY":
      return ["wait_execution", "send_targeted_input_or_control", "use_another_session"];
    case "INPUT_GUARDED":
      return ["observe_interaction", "wait_for_guard_expiry", "retry_after_reobserve"];
    case "POLICY_DENIED":
      return ["observe_interaction", "change_policy_as_human"];
    case "SCREEN_CHANGED":
    case "RESYNC_REQUIRED":
      return ["refresh_screen", "reconnect_stream"];
    case "INPUT_CONTEXT_CHANGED":
      return ["observe_interaction", "retry_after_reobserve"];
    case "INPUT_CONTEXT_UNSAFE":
      return ["observe_interaction", "inspect_input_delivery", "inspect_raw_input_state"];
    case "GEOMETRY_CHANGED":
      return ["refresh_screen", "retry_after_reobserve"];
    case "CHECKPOINT_CHANGED":
      return ["refresh_checkpoint", "retry_with_new_version"];
    case "CHECKPOINT_STALE":
      return ["review_checkpoint", "acknowledge_stale_context"];
    case "CHECKPOINT_INVALID":
    case "CHECKPOINT_NOT_FOUND":
      return ["inspect_checkpoint", "create_clean_session"];
    case "EXECUTION_CHANGED":
      return ["refresh_session", "target_current_execution"];
    case "APPROVAL_REQUIRED":
      return ["request_approval", "wait_for_human_decision", "retry_exact_approved_action"];
    case "APPROVAL_CHANGED":
      return ["refresh_approval", "decide_current_version"];
    case "SENSITIVE_INPUT_ACTIVE":
      return ["review_sensitive_input", "human_control_or_finish_sensitive_period"];
    case "SENSITIVE_INPUT_CHANGED":
      return ["refresh_sensitive_input"];
    case "BACKPRESSURE":
      return ["wait_and_retry_same_idempotency_key"];
    case "RATE_LIMITED":
      return ["wait_for_retry_after", "retry_same_idempotency_key"];
    case "DELIVERY_UNKNOWN":
      return ["inspect_events", "reconcile_idempotency_key"];
    case "RUNTIME_UNAVAILABLE":
      return ["inspect_runtime_health", "reconnect_console"];
    default:
      return [];
  }
}

function sameActor(left: Actor, right: Actor): boolean {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.principal === right.principal &&
    left.client === right.client &&
    left.capabilities.length === right.capabilities.length &&
    left.capabilities.every((capability, index) => right.capabilities[index] === capability)
  );
}

class ConsoleHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}
