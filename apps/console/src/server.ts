import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";

import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { Actor, EventPage, InteractionState, Session } from "@iterminal/domain";
import {
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
const MAX_CONSOLE_ACTORS = 256;
const MAX_WS_BUFFERED_BYTES = 1024 * 1024;
const STREAM_WAIT_MS = 1_000;
const STREAM_EVENT_LIMIT = 100;

const identitySchema = z.strictObject({
  generation: z.number().int().positive(),
});
const sessionParamsSchema = z.strictObject({ sessionId: z.string().min(1).max(256) });
const createSessionSchema = z.strictObject({
  shell: z.enum(["bash", "zsh"]),
  workspaceRoot: z.string().min(1).max(4_096),
});
const executeSchema = identitySchema.extend({
  command: z
    .string()
    .min(1)
    .max(256 * 1_024),
  idempotencyKey: z.string().min(1).max(256),
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
  idempotencyKey: z.string().min(1).max(256),
  targetExecutionId: z.string().min(1).max(256),
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
  readonly now?: () => number;
  readonly port?: number;
  readonly staticRoot?: string;
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
  const actors = new Map<string, ConsoleActorRecord>();
  const openSessionStreams = new Map<string, number>();
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger: options.logger ?? false,
    requestIdHeader: "x-request-id",
  });

  await app.register(fastifyWebsocket, {
    options: { maxPayload: 16 * 1_024 },
  });

  app.addHook("onRequest", async (request, reply) => {
    applySecurityHeaders(reply);
    validateHost(request);
    const isWebSocket = request.headers.upgrade?.toLowerCase() === "websocket";
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (isWebSocket || mutating) validateSameOrigin(request);
    if (mutating && request.headers["x-iterminal-request"] !== "console") {
      throw new ConsoleHttpError(403, "INVALID_REQUEST", "Missing Console request header");
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const envelope = errorEnvelope(error, request.id);
    void reply.status(envelope.status).send({ error: envelope.error });
  });

  app.get("/api/bootstrap", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now, true);
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
    const session = await options.gateway.getSession(sessionId);
    if (session.generation !== body.generation || session.status !== "READY") {
      throw modeError(session, body.generation, "Execute requires READY command-composer mode");
    }
    return reply.status(202).send(
      success(
        request,
        await options.gateway.startExecute({
          actor,
          command: body.command,
          idempotencyKey: body.idempotencyKey,
          sessionGeneration: body.generation,
          sessionId,
        }),
      ),
    );
  });

  app.post("/api/sessions/:sessionId/input", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const body = inputSchema.parse(request.body);
    await requireRunningTarget(options.gateway, sessionId, body.generation, body.targetExecutionId);
    return reply.status(202).send(
      success(
        request,
        await options.gateway.sendInput({
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

  app.post("/api/sessions/:sessionId/control", async (request, reply) => {
    const actor = actorForRequest(request, reply, actors, now);
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const body = controlSchema.parse(request.body);
    await requireRunningTarget(options.gateway, sessionId, body.generation, body.targetExecutionId);
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
      preValidation: async (request, reply) => {
        actorForRequest(request, reply, actors, now);
        sessionParamsSchema.parse(request.params);
        streamQuerySchema.parse(request.query);
      },
      websocket: true,
    },
    (socket, request) => {
      const actor = actorForRequest(request, undefined, actors, now);
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const query = streamQuerySchema.parse(request.query);
      const streamKey = `${actor.id}:${sessionId}:${query.generation.toString()}`;
      openSessionStreams.set(streamKey, (openSessionStreams.get(streamKey) ?? 0) + 1);
      void streamSession(socket, options.gateway, actor, sessionId, query).finally(async () => {
        const remaining = (openSessionStreams.get(streamKey) ?? 1) - 1;
        if (remaining <= 0) {
          openSessionStreams.delete(streamKey);
          await releaseActorGuard(options.gateway, actor, sessionId, query.generation);
        } else {
          openSessionStreams.set(streamKey, remaining);
        }
      });
    },
  );

  const staticRoot = options.staticRoot ?? resolve(process.cwd(), "dist/console-web");
  if (existsSync(staticRoot)) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      wildcard: false,
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
      void reply.type("text/html").sendFile("index.html");
    });
  }

  return app;
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
      if (session.status === "BROKEN" || session.status === "CLOSED") return;
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
  if (actors.size >= MAX_CONSOLE_ACTORS) {
    throw new ConsoleHttpError(503, "BACKPRESSURE", "Console Actor capacity is exhausted", true);
  }
  const id = randomUUID();
  const actor: Actor = {
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

function validateHost(request: FastifyRequest): void {
  const host = request.headers.host;
  if (host === undefined) throw new ConsoleHttpError(400, "INVALID_REQUEST", "Host is required");
  const hostname = authorityHostname(host);
  if (!isLoopbackHostname(hostname)) {
    throw new ConsoleHttpError(403, "POLICY_DENIED", "Console Host must resolve to loopback");
  }
  const localPort = request.socket.localPort;
  const hostPort = authorityPort(host);
  if (localPort !== undefined && hostPort !== undefined && hostPort !== localPort) {
    throw new ConsoleHttpError(403, "POLICY_DENIED", "Console Host port does not match listener");
  }
}

function validateSameOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin === undefined || host === undefined) {
    throw new ConsoleHttpError(403, "POLICY_DENIED", "Same-origin Console request required");
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ConsoleHttpError(403, "POLICY_DENIED", "Console Origin is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.host !== host ||
    !isLoopbackHostname(parsed.hostname)
  ) {
    throw new ConsoleHttpError(403, "POLICY_DENIED", "Console Origin does not match Host");
  }
}

function authorityHostname(authority: string): string {
  try {
    return new URL(`http://${authority}`).hostname;
  } catch {
    throw new ConsoleHttpError(400, "INVALID_REQUEST", "Host is malformed");
  }
}

function authorityPort(authority: string): number | undefined {
  try {
    const port = new URL(`http://${authority}`).port;
    return port.length === 0 ? undefined : Number.parseInt(port, 10);
  } catch {
    throw new ConsoleHttpError(400, "INVALID_REQUEST", "Host is malformed");
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
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
        details: { issues: error.issues },
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
      message: error instanceof Error ? error.message : "Console request failed",
      requestId,
      retryable: true,
    },
    status: 500,
  };
}

function runtimeStatus(code: RuntimeError["code"]): number {
  switch (code) {
    case "SESSION_NOT_FOUND":
    case "EXECUTION_NOT_FOUND":
      return 404;
    case "POLICY_DENIED":
      return 403;
    case "INPUT_GUARDED":
      return 423;
    case "BACKPRESSURE":
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
    case "BACKPRESSURE":
      return ["wait_and_retry_same_idempotency_key"];
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
    left.client === right.client
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
