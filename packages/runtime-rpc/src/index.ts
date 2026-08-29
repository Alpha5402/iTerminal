import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

import type {
  ControlRequest,
  CreateSessionRequest,
  ExecuteRequest,
  InputRequest,
} from "@iterminal/application";
import type { RuntimeService } from "@iterminal/application";
import type {
  ControlAction,
  EventPage,
  ExecuteAction,
  Execution,
  InputAction,
  Session,
} from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";
import * as z from "zod/v4";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const WAIT_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const runtimeErrorCodes = new Set<RuntimeError["code"]>([
  "SESSION_NOT_FOUND",
  "SESSION_NOT_READY",
  "SESSION_BROKEN",
  "SESSION_GENERATION_CHANGED",
  "PTY_BUSY",
  "EXECUTION_CHANGED",
  "SCREEN_CHANGED",
  "IDEMPOTENCY_KEY_REUSED",
  "DELIVERY_UNKNOWN",
  "RUNTIME_UNAVAILABLE",
  "RESYNC_REQUIRED",
  "INVALID_REQUEST",
  "EXECUTION_NOT_FOUND",
]);

const actorSchema = z.strictObject({
  client: z.string().min(1).max(256),
  id: z.string().min(1).max(256),
  principal: z.string().min(1).max(256),
  type: z.enum(["human", "agent", "scheduler", "system"]),
});

const sessionIdentitySchema = z.strictObject({
  generation: z.number().int().positive(),
  sessionId: z.string().min(1).max(256),
});

const operationSchemas = {
  "control.send": sessionIdentitySchema.extend({
    actor: actorSchema,
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
  }),
  "events.query": sessionIdentitySchema.extend({
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  "execution.get": z.strictObject({ executionId: z.string().min(1).max(256) }),
  "execution.start": sessionIdentitySchema.extend({
    actor: actorSchema,
    command: z.string().max(256 * 1024),
    idempotencyKey: z.string().min(1).max(256),
  }),
  "execution.wait": z.strictObject({ executionId: z.string().min(1).max(256) }),
  "input.send": sessionIdentitySchema.extend({
    actor: actorSchema,
    data: z.string().max(64 * 1024),
    expectedScreenVersion: z.number().int().nonnegative().optional(),
    idempotencyKey: z.string().min(1).max(256),
    targetExecutionId: z.string().min(1).max(256),
  }),
  "session.close": sessionIdentitySchema,
  "session.create": z.strictObject({
    ownerId: z.string().min(1).max(256).optional(),
    shell: z.enum(["bash", "zsh"]),
    workspaceRoot: z.string().min(1).max(4096),
  }),
  "session.get": z.strictObject({ sessionId: z.string().min(1).max(256) }),
  "session.list": z.strictObject({}),
} as const;

export type RuntimeOperation = keyof typeof operationSchemas;

export interface StartedExecutionView {
  readonly action: ExecuteAction;
  readonly execution: Execution;
}

export interface RuntimeGateway {
  createSession(request: CreateSessionRequest): Promise<Session>;
  getSession(sessionId: string): Promise<Session>;
  listSessions(): Promise<readonly Session[]>;
  startExecute(request: ExecuteRequest): Promise<StartedExecutionView>;
  getExecution(executionId: string): Promise<Execution>;
  waitExecution(executionId: string): Promise<Execution>;
  sendInput(request: InputRequest): Promise<InputAction>;
  sendControl(request: ControlRequest): Promise<ControlAction>;
  queryEvents(
    sessionId: string,
    generation: number,
    after?: number,
    limit?: number,
  ): Promise<EventPage>;
  closeSession(sessionId: string, generation: number): Promise<Session>;
}

export class LocalRuntimeGateway implements RuntimeGateway {
  public constructor(private readonly runtime: RuntimeService) {}

  public createSession(request: CreateSessionRequest): Promise<Session> {
    return this.runtime.createSession(request);
  }

  public getSession(sessionId: string): Promise<Session> {
    return Promise.resolve(this.runtime.getSession(sessionId));
  }

  public listSessions(): Promise<readonly Session[]> {
    return Promise.resolve(this.runtime.listSessions());
  }

  public startExecute(request: ExecuteRequest): Promise<StartedExecutionView> {
    const started = this.runtime.startExecute(request);
    return Promise.resolve({ action: started.action, execution: started.execution });
  }

  public getExecution(executionId: string): Promise<Execution> {
    return Promise.resolve(this.runtime.getExecution(executionId));
  }

  public waitExecution(executionId: string): Promise<Execution> {
    return this.runtime.waitExecution(executionId);
  }

  public sendInput(request: InputRequest): Promise<InputAction> {
    return Promise.resolve(this.runtime.sendInput(request));
  }

  public sendControl(request: ControlRequest): Promise<ControlAction> {
    return Promise.resolve(this.runtime.sendControl(request));
  }

  public queryEvents(
    sessionId: string,
    generation: number,
    after = 0,
    limit = 100,
  ): Promise<EventPage> {
    return Promise.resolve(this.runtime.queryEvents(sessionId, generation, after, limit));
  }

  public closeSession(sessionId: string, generation: number): Promise<Session> {
    return Promise.resolve(this.runtime.closeSession(sessionId, generation));
  }
}

interface RpcRequest {
  readonly id: string;
  readonly operation: RuntimeOperation;
  readonly input: unknown;
}

type RpcResponse =
  | Readonly<{ id: string; ok: true; result: unknown }>
  | Readonly<{
      id: string;
      ok: false;
      error: Readonly<{
        code: string;
        details: Readonly<Record<string, unknown>>;
        message: string;
        retryable: boolean;
      }>;
    }>;

export interface RuntimeRpcServerHandle {
  readonly socketPath: string;
  close(): Promise<void>;
}

export async function startRuntimeRpcServer(options: {
  readonly socketPath: string;
  readonly gateway: RuntimeGateway;
}): Promise<RuntimeRpcServerHandle> {
  await prepareSocketPath(options.socketPath);
  const activeSockets = new Set<Socket>();
  const server = createServer((socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
    handleSocket(socket, options.gateway);
  });
  const previousUmask = process.umask(0o177);
  try {
    await listen(server, options.socketPath);
  } finally {
    process.umask(previousUmask);
  }
  try {
    await chmod(options.socketPath, 0o600);
  } catch (error) {
    await closeServer(server, activeSockets).catch(() => undefined);
    await unlink(options.socketPath).catch(() => undefined);
    throw error;
  }
  let closed = false;
  return {
    socketPath: options.socketPath,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await closeServer(server, activeSockets);
      await unlink(options.socketPath).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
      });
    },
  };
}

export class UnixRuntimeClient implements RuntimeGateway {
  public constructor(private readonly socketPath: string) {}

  public createSession(request: CreateSessionRequest): Promise<Session> {
    return this.#request("session.create", {
      shell: request.shell,
      workspaceRoot: request.workspaceRoot,
      ...(request.ownerId === undefined ? {} : { ownerId: request.ownerId }),
    });
  }

  public getSession(sessionId: string): Promise<Session> {
    return this.#request("session.get", { sessionId });
  }

  public listSessions(): Promise<readonly Session[]> {
    return this.#request("session.list", {});
  }

  public startExecute(request: ExecuteRequest): Promise<StartedExecutionView> {
    return this.#request("execution.start", {
      actor: request.actor,
      command: request.command,
      generation: request.sessionGeneration,
      idempotencyKey: request.idempotencyKey,
      sessionId: request.sessionId,
    });
  }

  public getExecution(executionId: string): Promise<Execution> {
    return this.#request("execution.get", { executionId });
  }

  public waitExecution(executionId: string): Promise<Execution> {
    return this.#request("execution.wait", { executionId }, WAIT_REQUEST_TIMEOUT_MS);
  }

  public sendInput(request: InputRequest): Promise<InputAction> {
    return this.#request("input.send", {
      actor: request.actor,
      data: request.data,
      generation: request.sessionGeneration,
      idempotencyKey: request.idempotencyKey,
      sessionId: request.sessionId,
      targetExecutionId: request.targetExecutionId,
      ...(request.expectedScreenVersion === undefined
        ? {}
        : { expectedScreenVersion: request.expectedScreenVersion }),
    });
  }

  public sendControl(request: ControlRequest): Promise<ControlAction> {
    return this.#request("control.send", {
      actor: request.actor,
      delivery: request.delivery,
      generation: request.sessionGeneration,
      idempotencyKey: request.idempotencyKey,
      sessionId: request.sessionId,
      targetExecutionId: request.targetExecutionId,
    });
  }

  public queryEvents(
    sessionId: string,
    generation: number,
    after = 0,
    limit = 100,
  ): Promise<EventPage> {
    return this.#request("events.query", { after, generation, limit, sessionId });
  }

  public closeSession(sessionId: string, generation: number): Promise<Session> {
    return this.#request("session.close", { generation, sessionId });
  }

  #request<T>(
    operation: RuntimeOperation,
    input: unknown,
    timeoutMilliseconds = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const id = `rpc_${randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      const timeout = setTimeout(() => {
        socket.destroy();
        fail(new Error("Runtime RPC request timed out"));
      }, timeoutMilliseconds);
      const cleanup = (): void => clearTimeout(timeout);
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(connectionError(operation, id, error));
      };
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ id, input, operation })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
          fail(new Error("Runtime RPC response exceeded the size limit"));
          socket.destroy();
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0 || settled) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as RpcResponse;
          if (response.id !== id) throw new Error("Runtime RPC response ID mismatch");
          settled = true;
          cleanup();
          socket.end();
          if (response.ok) {
            resolve(response.result as T);
          } else {
            reject(
              new RuntimeError(
                runtimeErrorCode(response.error.code),
                response.error.message,
                response.error.details,
                response.error.retryable,
              ),
            );
          }
        } catch (error) {
          fail(error);
          socket.destroy();
        }
      });
      socket.once("error", fail);
      socket.once("close", () => {
        if (!settled) fail(new Error("Runtime RPC connection closed before a response"));
      });
    });
  }
}

function handleSocket(socket: Socket, gateway: RuntimeGateway): void {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
      socket.destroy();
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = "";
    socket.pause();
    void respond(socket, line, gateway);
  });
}

async function respond(socket: Socket, line: string, gateway: RuntimeGateway): Promise<void> {
  let id = "unassigned";
  try {
    const candidate: unknown = JSON.parse(line);
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new RuntimeError("INVALID_REQUEST", "Runtime RPC request must be an object");
    }
    const parsed = candidate as Partial<RpcRequest>;
    if (typeof parsed.id === "string") id = parsed.id;
    if (typeof parsed.id !== "string" || parsed.id.length === 0 || parsed.id.length > 256) {
      throw new RuntimeError("INVALID_REQUEST", "Runtime RPC request ID is invalid");
    }
    if (
      typeof parsed.operation !== "string" ||
      !Object.hasOwn(operationSchemas, parsed.operation)
    ) {
      throw new RuntimeError("INVALID_REQUEST", "Unsupported Runtime RPC operation");
    }
    const operation = parsed.operation;
    const input = operationSchemas[operation].parse(parsed.input);
    const result = await dispatch(gateway, operation, input);
    writeResponse(socket, { id, ok: true, result });
  } catch (error) {
    const runtimeError = normalizeError(error);
    writeResponse(socket, {
      error: {
        code: runtimeError.code,
        details: runtimeError.details,
        message: runtimeError.message,
        retryable: runtimeError.retryable,
      },
      id,
      ok: false,
    });
  }
}

async function dispatch(
  gateway: RuntimeGateway,
  operation: RuntimeOperation,
  input: z.output<(typeof operationSchemas)[RuntimeOperation]>,
): Promise<unknown> {
  switch (operation) {
    case "session.create": {
      const request = operationSchemas[operation].parse(input);
      return gateway.createSession({
        shell: request.shell,
        workspaceRoot: request.workspaceRoot,
        ...(request.ownerId === undefined ? {} : { ownerId: request.ownerId }),
      });
    }
    case "session.get": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getSession(request.sessionId);
    }
    case "session.list":
      return gateway.listSessions();
    case "session.close": {
      const request = operationSchemas[operation].parse(input);
      return gateway.closeSession(request.sessionId, request.generation);
    }
    case "execution.start": {
      const request = operationSchemas[operation].parse(input);
      return gateway.startExecute({
        actor: request.actor,
        command: request.command,
        idempotencyKey: request.idempotencyKey,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
      });
    }
    case "execution.get": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getExecution(request.executionId);
    }
    case "execution.wait": {
      const request = operationSchemas[operation].parse(input);
      return gateway.waitExecution(request.executionId);
    }
    case "input.send": {
      const request = operationSchemas[operation].parse(input);
      return gateway.sendInput({
        actor: request.actor,
        data: request.data,
        idempotencyKey: request.idempotencyKey,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
        targetExecutionId: request.targetExecutionId,
        ...(request.expectedScreenVersion === undefined
          ? {}
          : { expectedScreenVersion: request.expectedScreenVersion }),
      });
    }
    case "control.send": {
      const request = operationSchemas[operation].parse(input);
      return gateway.sendControl({
        actor: request.actor,
        delivery: request.delivery,
        idempotencyKey: request.idempotencyKey,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
        targetExecutionId: request.targetExecutionId,
      });
    }
    case "events.query": {
      const request = operationSchemas[operation].parse(input);
      return gateway.queryEvents(
        request.sessionId,
        request.generation,
        request.after,
        request.limit,
      );
    }
  }
}

function writeResponse(socket: Socket, response: RpcResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  const status = await lstat(socketPath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (status === undefined) return;
  if (!status.isSocket()) {
    throw new RuntimeError("INVALID_REQUEST", "Runtime socket path exists and is not a socket", {
      socketPath,
    });
  }
  const live = await canConnect(socketPath);
  if (live) {
    throw new RuntimeError("INVALID_REQUEST", "Runtime daemon is already listening", {
      socketPath,
    });
  }
  await unlink(socketPath);
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server, activeSockets: ReadonlySet<Socket>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    for (const socket of activeSockets) socket.destroy();
  });
}

function normalizeError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) return error;
  if (error instanceof z.ZodError) {
    return new RuntimeError("INVALID_REQUEST", z.prettifyError(error));
  }
  return new RuntimeError("RUNTIME_UNAVAILABLE", errorMessage(error), {}, true);
}

function connectionError(
  operation: RuntimeOperation,
  requestId: string,
  error: unknown,
): RuntimeError {
  const details = { operation, requestId, reason: errorMessage(error) };
  if (isMutating(operation)) {
    return new RuntimeError(
      "DELIVERY_UNKNOWN",
      "Runtime RPC delivery or result is uncertain; inspect by idempotency key before retrying",
      details,
    );
  }
  return new RuntimeError("RUNTIME_UNAVAILABLE", "Runtime daemon is unavailable", details, true);
}

function isMutating(operation: RuntimeOperation): boolean {
  return (
    operation === "session.create" ||
    operation === "session.close" ||
    operation === "execution.start" ||
    operation === "input.send" ||
    operation === "control.send"
  );
}

function runtimeErrorCode(code: string): RuntimeError["code"] {
  return runtimeErrorCodes.has(code as RuntimeError["code"])
    ? (code as RuntimeError["code"])
    : "RUNTIME_UNAVAILABLE";
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
