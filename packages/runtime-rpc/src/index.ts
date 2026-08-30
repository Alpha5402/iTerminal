import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";

import type {
  AcquireInteractionGuardRequest,
  ControlRequest,
  CreateSessionRequest,
  ExecuteRequest,
  InputRequest,
  ReleaseInteractionGuardRequest,
  RenewInteractionGuardRequest,
  ScreenCellsRequest,
  ScreenDiffRequest,
  ScreenRegionRequest,
  ScreenSearchRequest,
  ScreenWaitRequest,
  SetInputPolicyRequest,
} from "@iterminal/application";
import type { RuntimeService } from "@iterminal/application";
import type {
  ControlAction,
  EventPage,
  ExecuteAction,
  Execution,
  InputAction,
  InteractionState,
  Session,
  TerminalScreenCellsResult,
  TerminalScreenDiffResult,
  TerminalScreenRegionResult,
  TerminalScreenSearchResult,
  TerminalScreenSnapshot,
  TerminalScreenWaitResult,
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
  "INPUT_GUARDED",
  "INTERACTION_GUARD_CHANGED",
  "POLICY_DENIED",
  "IDEMPOTENCY_KEY_REUSED",
  "DELIVERY_UNKNOWN",
  "BACKPRESSURE",
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

const screenRectangleSchema = sessionIdentitySchema.extend({
  columnCount: z.number().int().min(1).max(120),
  rowCount: z.number().int().min(1).max(40),
  startColumn: z.number().int().min(0).max(119),
  startRow: z.number().int().min(0).max(39),
});

const operationSchemas = {
  "control.send": sessionIdentitySchema.extend({
    actor: actorSchema,
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
  }),
  "events.query": sessionIdentitySchema.extend({
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  "execution.get": z.strictObject({ executionId: z.string().min(1).max(256) }),
  "execution.dispatch": z.strictObject({ executionId: z.string().min(1).max(256) }),
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
  "interaction.get": sessionIdentitySchema,
  "interaction.guard.acquire": sessionIdentitySchema.extend({
    actor: actorSchema,
    expectedVersion: z.number().int().positive(),
    reason: z.string().min(1).max(256),
    ttlMilliseconds: z.number().int().min(50).max(5_000).optional(),
  }),
  "interaction.guard.release": sessionIdentitySchema.extend({
    actor: actorSchema,
    expectedVersion: z.number().int().positive(),
    guardId: z.string().min(1).max(256),
  }),
  "interaction.guard.renew": sessionIdentitySchema.extend({
    actor: actorSchema,
    expectedVersion: z.number().int().positive(),
    guardId: z.string().min(1).max(256),
    ttlMilliseconds: z.number().int().min(50).max(5_000).optional(),
  }),
  "interaction.policy.set": sessionIdentitySchema.extend({
    actor: actorSchema,
    expectedVersion: z.number().int().positive(),
    mode: z.enum(["common", "human_guarded", "human_only", "agent_only"]),
  }),
  "screen.cells": screenRectangleSchema,
  "screen.diff": sessionIdentitySchema.extend({
    afterVersion: z.number().int().nonnegative(),
  }),
  "screen.get": sessionIdentitySchema,
  "screen.region": screenRectangleSchema,
  "screen.search": sessionIdentitySchema.extend({
    caseSensitive: z.boolean().default(false),
    maxMatches: z.number().int().min(1).max(100).default(20),
    query: z.string().min(1).max(1_024),
  }),
  "screen.wait": sessionIdentitySchema.extend({
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
        executionId: z.string().min(1).max(256),
        type: z.literal("execution_exit"),
      }),
    ]),
    timeoutMilliseconds: z.number().int().min(1).max(300_000).default(30_000),
  }),
  "session.close": sessionIdentitySchema,
  "session.create": z.strictObject({
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
  getScreen(sessionId: string, generation: number): Promise<TerminalScreenSnapshot>;
  getScreenCells(request: ScreenCellsRequest): Promise<TerminalScreenCellsResult>;
  getScreenDiff(request: ScreenDiffRequest): Promise<TerminalScreenDiffResult>;
  getScreenRegion(request: ScreenRegionRequest): Promise<TerminalScreenRegionResult>;
  searchScreen(request: ScreenSearchRequest): Promise<TerminalScreenSearchResult>;
  waitForScreen(
    request: ScreenWaitRequest,
    signal?: AbortSignal,
  ): Promise<TerminalScreenWaitResult>;
  startExecute(request: ExecuteRequest): Promise<StartedExecutionView>;
  dispatchExecution(executionId: string): Promise<StartedExecutionView>;
  getExecution(executionId: string): Promise<Execution>;
  waitExecution(executionId: string): Promise<Execution>;
  sendInput(request: InputRequest): Promise<InputAction>;
  sendControl(request: ControlRequest): Promise<ControlAction>;
  getInteractionState(sessionId: string, generation: number): Promise<InteractionState>;
  setInputPolicy(request: SetInputPolicyRequest): Promise<InteractionState>;
  acquireInteractionGuard(request: AcquireInteractionGuardRequest): Promise<InteractionState>;
  renewInteractionGuard(request: RenewInteractionGuardRequest): Promise<InteractionState>;
  releaseInteractionGuard(request: ReleaseInteractionGuardRequest): Promise<InteractionState>;
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

  public getScreen(sessionId: string, generation: number): Promise<TerminalScreenSnapshot> {
    return this.runtime.getScreen(sessionId, generation);
  }

  public getScreenCells(request: ScreenCellsRequest): Promise<TerminalScreenCellsResult> {
    return this.runtime.getScreenCells(request);
  }

  public getScreenDiff(request: ScreenDiffRequest): Promise<TerminalScreenDiffResult> {
    return this.runtime.getScreenDiff(request);
  }

  public getScreenRegion(request: ScreenRegionRequest): Promise<TerminalScreenRegionResult> {
    return this.runtime.getScreenRegion(request);
  }

  public searchScreen(request: ScreenSearchRequest): Promise<TerminalScreenSearchResult> {
    return this.runtime.searchScreen(request);
  }

  public waitForScreen(
    request: ScreenWaitRequest,
    signal?: AbortSignal,
  ): Promise<TerminalScreenWaitResult> {
    return this.runtime.waitForScreen(request, signal);
  }

  public async startExecute(request: ExecuteRequest): Promise<StartedExecutionView> {
    const started = await this.runtime.startExecute(request);
    return Promise.resolve({ action: started.action, execution: started.execution });
  }

  public async dispatchExecution(executionId: string): Promise<StartedExecutionView> {
    const started = await this.runtime.dispatchExecution(executionId);
    return { action: started.action, execution: started.execution };
  }

  public getExecution(executionId: string): Promise<Execution> {
    return Promise.resolve(this.runtime.getExecution(executionId));
  }

  public waitExecution(executionId: string): Promise<Execution> {
    return this.runtime.waitExecution(executionId);
  }

  public sendInput(request: InputRequest): Promise<InputAction> {
    return this.runtime.sendInput(request);
  }

  public sendControl(request: ControlRequest): Promise<ControlAction> {
    return this.runtime.sendControl(request);
  }

  public getInteractionState(sessionId: string, generation: number): Promise<InteractionState> {
    return this.runtime.getInteractionState(sessionId, generation);
  }

  public setInputPolicy(request: SetInputPolicyRequest): Promise<InteractionState> {
    return this.runtime.setInputPolicy(request);
  }

  public acquireInteractionGuard(
    request: AcquireInteractionGuardRequest,
  ): Promise<InteractionState> {
    return this.runtime.acquireInteractionGuard(request);
  }

  public renewInteractionGuard(request: RenewInteractionGuardRequest): Promise<InteractionState> {
    return this.runtime.renewInteractionGuard(request);
  }

  public releaseInteractionGuard(
    request: ReleaseInteractionGuardRequest,
  ): Promise<InteractionState> {
    return this.runtime.releaseInteractionGuard(request);
  }

  public queryEvents(
    sessionId: string,
    generation: number,
    after = 0,
    limit = 100,
  ): Promise<EventPage> {
    return this.runtime.queryEvents(sessionId, generation, after, limit);
  }

  public closeSession(sessionId: string, generation: number): Promise<Session> {
    return this.runtime.closeSession(sessionId, generation);
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
  readonly isReady?: () => boolean;
}): Promise<RuntimeRpcServerHandle> {
  await prepareSocketPath(options.socketPath);
  const activeSockets = new Set<Socket>();
  const server = createServer((socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
    handleSocket(socket, options.gateway, options.isReady);
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
    });
  }

  public getSession(sessionId: string): Promise<Session> {
    return this.#request("session.get", { sessionId });
  }

  public listSessions(): Promise<readonly Session[]> {
    return this.#request("session.list", {});
  }

  public getScreen(sessionId: string, generation: number): Promise<TerminalScreenSnapshot> {
    return this.#request("screen.get", { generation, sessionId });
  }

  public getScreenCells(request: ScreenCellsRequest): Promise<TerminalScreenCellsResult> {
    return this.#request("screen.cells", request);
  }

  public getScreenDiff(request: ScreenDiffRequest): Promise<TerminalScreenDiffResult> {
    return this.#request("screen.diff", request);
  }

  public getScreenRegion(request: ScreenRegionRequest): Promise<TerminalScreenRegionResult> {
    return this.#request("screen.region", request);
  }

  public searchScreen(request: ScreenSearchRequest): Promise<TerminalScreenSearchResult> {
    return this.#request("screen.search", request);
  }

  public waitForScreen(request: ScreenWaitRequest): Promise<TerminalScreenWaitResult> {
    return this.#request("screen.wait", request, WAIT_REQUEST_TIMEOUT_MS);
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

  public dispatchExecution(executionId: string): Promise<StartedExecutionView> {
    return this.#request("execution.dispatch", { executionId });
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
      bypassGuard: request.bypassGuard ?? false,
      delivery: request.delivery,
      generation: request.sessionGeneration,
      idempotencyKey: request.idempotencyKey,
      sessionId: request.sessionId,
      targetExecutionId: request.targetExecutionId,
    });
  }

  public getInteractionState(sessionId: string, generation: number): Promise<InteractionState> {
    return this.#request("interaction.get", { generation, sessionId });
  }

  public setInputPolicy(request: SetInputPolicyRequest): Promise<InteractionState> {
    return this.#request("interaction.policy.set", {
      actor: request.actor,
      expectedVersion: request.expectedVersion,
      generation: request.sessionGeneration,
      mode: request.mode,
      sessionId: request.sessionId,
    });
  }

  public acquireInteractionGuard(
    request: AcquireInteractionGuardRequest,
  ): Promise<InteractionState> {
    return this.#request("interaction.guard.acquire", {
      actor: request.actor,
      expectedVersion: request.expectedVersion,
      generation: request.sessionGeneration,
      reason: request.reason,
      sessionId: request.sessionId,
      ...(request.ttlMilliseconds === undefined
        ? {}
        : { ttlMilliseconds: request.ttlMilliseconds }),
    });
  }

  public renewInteractionGuard(request: RenewInteractionGuardRequest): Promise<InteractionState> {
    return this.#request("interaction.guard.renew", {
      actor: request.actor,
      expectedVersion: request.expectedVersion,
      generation: request.sessionGeneration,
      guardId: request.guardId,
      sessionId: request.sessionId,
      ...(request.ttlMilliseconds === undefined
        ? {}
        : { ttlMilliseconds: request.ttlMilliseconds }),
    });
  }

  public releaseInteractionGuard(
    request: ReleaseInteractionGuardRequest,
  ): Promise<InteractionState> {
    return this.#request("interaction.guard.release", {
      actor: request.actor,
      expectedVersion: request.expectedVersion,
      generation: request.sessionGeneration,
      guardId: request.guardId,
      sessionId: request.sessionId,
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

function handleSocket(
  socket: Socket,
  gateway: RuntimeGateway,
  isReady: (() => boolean) | undefined,
): void {
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
    void respond(socket, line, gateway, isReady);
  });
}

async function respond(
  socket: Socket,
  line: string,
  gateway: RuntimeGateway,
  isReady: (() => boolean) | undefined,
): Promise<void> {
  let id = "unassigned";
  const abortController = new AbortController();
  const onSocketClose = (): void => abortController.abort();
  socket.once("close", onSocketClose);
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
    if (isReady !== undefined && !isReady()) {
      throw new RuntimeError(
        "RUNTIME_UNAVAILABLE",
        "Runtime daemon is still initializing",
        {},
        true,
      );
    }
    const input = operationSchemas[operation].parse(parsed.input);
    const result = await dispatch(gateway, operation, input, abortController.signal);
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
  } finally {
    socket.off("close", onSocketClose);
  }
}

async function dispatch(
  gateway: RuntimeGateway,
  operation: RuntimeOperation,
  input: z.output<(typeof operationSchemas)[RuntimeOperation]>,
  signal: AbortSignal,
): Promise<unknown> {
  switch (operation) {
    case "session.create": {
      const request = operationSchemas[operation].parse(input);
      return gateway.createSession({
        shell: request.shell,
        workspaceRoot: request.workspaceRoot,
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
    case "execution.dispatch": {
      const request = operationSchemas[operation].parse(input);
      return gateway.dispatchExecution(request.executionId);
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
        bypassGuard: request.bypassGuard,
        delivery: request.delivery,
        idempotencyKey: request.idempotencyKey,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
        targetExecutionId: request.targetExecutionId,
      });
    }
    case "interaction.get": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getInteractionState(request.sessionId, request.generation);
    }
    case "interaction.policy.set": {
      const request = operationSchemas[operation].parse(input);
      return gateway.setInputPolicy({
        actor: request.actor,
        expectedVersion: request.expectedVersion,
        mode: request.mode,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
      });
    }
    case "interaction.guard.acquire": {
      const request = operationSchemas[operation].parse(input);
      return gateway.acquireInteractionGuard({
        actor: request.actor,
        expectedVersion: request.expectedVersion,
        reason: request.reason,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
        ...(request.ttlMilliseconds === undefined
          ? {}
          : { ttlMilliseconds: request.ttlMilliseconds }),
      });
    }
    case "interaction.guard.renew": {
      const request = operationSchemas[operation].parse(input);
      return gateway.renewInteractionGuard({
        actor: request.actor,
        expectedVersion: request.expectedVersion,
        guardId: request.guardId,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
        ...(request.ttlMilliseconds === undefined
          ? {}
          : { ttlMilliseconds: request.ttlMilliseconds }),
      });
    }
    case "interaction.guard.release": {
      const request = operationSchemas[operation].parse(input);
      return gateway.releaseInteractionGuard({
        actor: request.actor,
        expectedVersion: request.expectedVersion,
        guardId: request.guardId,
        sessionGeneration: request.generation,
        sessionId: request.sessionId,
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
    case "screen.get": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getScreen(request.sessionId, request.generation);
    }
    case "screen.cells": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getScreenCells(request);
    }
    case "screen.diff": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getScreenDiff(request);
    }
    case "screen.region": {
      const request = operationSchemas[operation].parse(input);
      return gateway.getScreenRegion(request);
    }
    case "screen.search": {
      const request = operationSchemas[operation].parse(input);
      return gateway.searchScreen({
        caseSensitive: request.caseSensitive,
        generation: request.generation,
        maxMatches: request.maxMatches,
        query: request.query,
        sessionId: request.sessionId,
      });
    }
    case "screen.wait": {
      const request = operationSchemas[operation].parse(input);
      return gateway.waitForScreen(
        {
          condition: request.condition,
          generation: request.generation,
          sessionId: request.sessionId,
          timeoutMilliseconds: request.timeoutMilliseconds,
        },
        signal,
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
    operation === "execution.dispatch" ||
    operation === "execution.start" ||
    operation === "input.send" ||
    operation === "control.send" ||
    operation === "interaction.policy.set" ||
    operation === "interaction.guard.acquire" ||
    operation === "interaction.guard.renew" ||
    operation === "interaction.guard.release"
  );
}

export function runtimeOwnerIdForSocket(socketPath: string): string {
  return `owner_local_${createHash("sha256").update(socketPath).digest("hex").slice(0, 24)}`;
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
