import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  sessionCreationRequestHash,
  type AcquireInteractionGuardRequest,
  type ControlRequest,
  type CreateSessionRequest,
  type ExecuteRequest,
  type ForkSessionRequest,
  type InputRequest,
  type ReleaseInteractionGuardRequest,
  type RenewInteractionGuardRequest,
  type ResizeRequest,
  type RuntimeOwnerRegistry,
  type RuntimeOwnerRoute,
  type RuntimeRouteResolution,
  type ScreenCellsRequest,
  type ScreenDiffRequest,
  type ScreenRegionRequest,
  type ScreenSearchRequest,
  type ScreenWaitRequest,
  type SetInputPolicyRequest,
} from "@iterminal/application";
import type {
  ControlAction,
  EventPage,
  Execution,
  InputAction,
  InteractionState,
  ResizeAction,
  Session,
  SessionForkResult,
  ShellCheckpointView,
  TerminalScreenCellsResult,
  TerminalScreenDiffResult,
  TerminalScreenRegionResult,
  TerminalScreenSearchResult,
  TerminalScreenSnapshot,
  TerminalScreenWaitResult,
  TerminalStateObservation,
} from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";
import { PostgresRuntimeOwnerRegistry } from "@iterminal/persistence-postgres";
import {
  startRuntimeRpcServer,
  UnixRuntimeClient,
  type RuntimeGateway,
  type RuntimeRpcServerHandle,
  type StartedExecutionView,
} from "@iterminal/runtime-rpc";

export interface RuntimeRouterHandle extends RuntimeRpcServerHandle {
  readonly gateway: CentralRuntimeRouterGateway;
}

export interface RuntimeRouterHooks {
  readonly afterForward?: (input: {
    readonly operation: string;
    readonly owner: RuntimeOwnerRoute;
  }) => Promise<void> | void;
  readonly afterPlacementClaim?: (owner: RuntimeOwnerRoute) => Promise<void> | void;
}

type TargetKind = "execution" | "session";

export class CentralRuntimeRouterGateway implements RuntimeGateway {
  readonly #clients = new Map<string, RuntimeGateway>();

  public constructor(
    private readonly routes: RuntimeOwnerRegistry,
    private readonly clientFactory: (endpoint: string) => RuntimeGateway = (endpoint) =>
      new UnixRuntimeClient(endpoint),
    private readonly hooks: RuntimeRouterHooks = {},
  ) {}

  public async createSession(request: CreateSessionRequest): Promise<Session> {
    const idempotencyKey = request.idempotencyKey;
    if (idempotencyKey === undefined) {
      throw new RuntimeError(
        "INVALID_REQUEST",
        "Central Router Session creation requires an idempotency key",
      );
    }
    const claim = await this.#routeDatabase("session.create", () =>
      this.routes.claimSessionCreation({
        idempotencyKey,
        requestHash: sessionCreationRequestHash(request),
      }),
    );
    if (claim === undefined) {
      throw new RuntimeError(
        "OWNER_ROUTE_UNAVAILABLE",
        "No active Runtime owner can accept a new Session",
        { operation: "session.create" },
        true,
      );
    }
    const owner = claim.owner;
    await this.hooks.afterPlacementClaim?.(owner);
    if (claim.sessionId !== undefined) {
      const sessionId = claim.sessionId;
      const replay = await this.#forward(owner, "session.create", (client) =>
        client.getSession(sessionId),
      );
      return expectSessionOwner(replay, owner, "session.create");
    }
    const session = await this.#forward(owner, "session.create", (client) =>
      client.createSession(request),
    );
    return expectSessionOwner(session, owner, "session.create");
  }

  public async getSessionCheckpoint(
    sessionId: string,
    generation: number,
  ): Promise<ShellCheckpointView> {
    return this.#withSession(sessionId, "session.checkpoint.get", (client) =>
      client.getSessionCheckpoint(sessionId, generation),
    );
  }

  public async forkSession(request: ForkSessionRequest): Promise<SessionForkResult> {
    const routed = await this.#withSessionRoute(request.sessionId, "session.fork", (client) =>
      client.forkSession(request),
    );
    return {
      ...routed.result,
      session: expectSessionOwner(routed.result.session, routed.owner, "session.fork"),
    };
  }

  public async getSession(sessionId: string): Promise<Session> {
    const routed = await this.#withSessionRoute(sessionId, "session.get", (client) =>
      client.getSession(sessionId),
    );
    return expectSessionOwner(routed.result, routed.owner, "session.get");
  }

  public async listSessions(): Promise<readonly Session[]> {
    const resolutions = await this.#routeDatabase("session.list", () =>
      this.routes.listSessionOwnerRoutes(),
    );
    const owners = resolutions.map((resolution) =>
      requiredRoute(resolution, "session", "*", "session.list"),
    );
    const groups = await Promise.all(
      owners.map(async (owner) => {
        const sessions = await this.#forward(owner, "session.list", (client) =>
          client.listSessions(),
        );
        return sessions.map((session) => expectSessionOwner(session, owner, "session.list"));
      }),
    );
    const unique = new Map<string, Session>();
    for (const session of groups.flat()) {
      const existing = unique.get(session.id);
      if (existing !== undefined) {
        throw new RuntimeError(
          "OWNER_ROUTE_UNAVAILABLE",
          "Multiple live Runtime owners returned the same Session",
          {
            firstOwnerId: existing.ownerId,
            secondOwnerId: session.ownerId,
            sessionId: session.id,
          },
          false,
        );
      }
      unique.set(session.id, session);
    }
    return [...unique.values()].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  }

  public getScreen(sessionId: string, generation: number): Promise<TerminalScreenSnapshot> {
    return this.#withSession(sessionId, "screen.get", (client) =>
      client.getScreen(sessionId, generation),
    );
  }

  public getTerminalState(
    sessionId: string,
    generation: number,
  ): Promise<TerminalStateObservation> {
    return this.#withSession(sessionId, "terminal.state.get", (client) =>
      client.getTerminalState(sessionId, generation),
    );
  }

  public getScreenCells(request: ScreenCellsRequest): Promise<TerminalScreenCellsResult> {
    return this.#withSession(request.sessionId, "screen.cells", (client) =>
      client.getScreenCells(request),
    );
  }

  public getScreenDiff(request: ScreenDiffRequest): Promise<TerminalScreenDiffResult> {
    return this.#withSession(request.sessionId, "screen.diff", (client) =>
      client.getScreenDiff(request),
    );
  }

  public getScreenRegion(request: ScreenRegionRequest): Promise<TerminalScreenRegionResult> {
    return this.#withSession(request.sessionId, "screen.region", (client) =>
      client.getScreenRegion(request),
    );
  }

  public searchScreen(request: ScreenSearchRequest): Promise<TerminalScreenSearchResult> {
    return this.#withSession(request.sessionId, "screen.search", (client) =>
      client.searchScreen(request),
    );
  }

  public waitForScreen(
    request: ScreenWaitRequest,
    signal?: AbortSignal,
  ): Promise<TerminalScreenWaitResult> {
    return this.#withSession(request.sessionId, "screen.wait", (client) =>
      client.waitForScreen(request, signal),
    );
  }

  public startExecute(request: ExecuteRequest): Promise<StartedExecutionView> {
    return this.#withSession(request.sessionId, "execution.start", (client) =>
      client.startExecute(request),
    );
  }

  public dispatchExecution(executionId: string): Promise<StartedExecutionView> {
    return this.#withExecution(executionId, "execution.dispatch", (client) =>
      client.dispatchExecution(executionId),
    );
  }

  public getExecution(executionId: string): Promise<Execution> {
    return this.#withExecution(executionId, "execution.get", (client) =>
      client.getExecution(executionId),
    );
  }

  public waitExecution(executionId: string): Promise<Execution> {
    return this.#withExecution(executionId, "execution.wait", (client) =>
      client.waitExecution(executionId),
    );
  }

  public sendInput(request: InputRequest): Promise<InputAction> {
    return this.#withSession(request.sessionId, "input.send", (client) =>
      client.sendInput(request),
    );
  }

  public sendControl(request: ControlRequest): Promise<ControlAction> {
    return this.#withSession(request.sessionId, "control.send", (client) =>
      client.sendControl(request),
    );
  }

  public resizeTerminal(request: ResizeRequest): Promise<ResizeAction> {
    return this.#withSession(request.sessionId, "terminal.resize", (client) =>
      client.resizeTerminal(request),
    );
  }

  public getInteractionState(sessionId: string, generation: number): Promise<InteractionState> {
    return this.#withSession(sessionId, "interaction.get", (client) =>
      client.getInteractionState(sessionId, generation),
    );
  }

  public setInputPolicy(request: SetInputPolicyRequest): Promise<InteractionState> {
    return this.#withSession(request.sessionId, "interaction.policy.set", (client) =>
      client.setInputPolicy(request),
    );
  }

  public acquireInteractionGuard(
    request: AcquireInteractionGuardRequest,
  ): Promise<InteractionState> {
    return this.#withSession(request.sessionId, "interaction.guard.acquire", (client) =>
      client.acquireInteractionGuard(request),
    );
  }

  public renewInteractionGuard(request: RenewInteractionGuardRequest): Promise<InteractionState> {
    return this.#withSession(request.sessionId, "interaction.guard.renew", (client) =>
      client.renewInteractionGuard(request),
    );
  }

  public releaseInteractionGuard(
    request: ReleaseInteractionGuardRequest,
  ): Promise<InteractionState> {
    return this.#withSession(request.sessionId, "interaction.guard.release", (client) =>
      client.releaseInteractionGuard(request),
    );
  }

  public queryEvents(
    sessionId: string,
    generation: number,
    after = 0,
    limit = 100,
  ): Promise<EventPage> {
    return this.#withSession(sessionId, "events.query", (client) =>
      client.queryEvents(sessionId, generation, after, limit),
    );
  }

  public closeSession(sessionId: string, generation: number): Promise<Session> {
    return this.#withSession(sessionId, "session.close", (client) =>
      client.closeSession(sessionId, generation),
    );
  }

  async #withSession<T>(
    sessionId: string,
    operation: string,
    invoke: (client: RuntimeGateway) => Promise<T>,
  ): Promise<T> {
    return (await this.#withSessionRoute(sessionId, operation, invoke)).result;
  }

  async #withSessionRoute<T>(
    sessionId: string,
    operation: string,
    invoke: (client: RuntimeGateway) => Promise<T>,
  ): Promise<{ readonly owner: RuntimeOwnerRoute; readonly result: T }> {
    const route = await this.#routeDatabase(operation, () =>
      this.routes.resolveSessionRoute(sessionId),
    );
    const owner = requiredRoute(route, "session", sessionId, operation);
    return { owner, result: await this.#forward(owner, operation, invoke) };
  }

  async #withExecution<T>(
    executionId: string,
    operation: string,
    invoke: (client: RuntimeGateway) => Promise<T>,
  ): Promise<T> {
    const route = await this.#routeDatabase(operation, () =>
      this.routes.resolveExecutionRoute(executionId),
    );
    const owner = requiredRoute(route, "execution", executionId, operation);
    return this.#forward(owner, operation, invoke);
  }

  async #routeDatabase<T>(operation: string, query: () => Promise<T>): Promise<T> {
    try {
      return await query();
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(
        "RUNTIME_UNAVAILABLE",
        "Runtime Router durable route database is unavailable",
        { component: "runtime-router", operation, phase: "route_resolution" },
        true,
      );
    }
  }

  async #forward<T>(
    owner: RuntimeOwnerRoute,
    operation: string,
    invoke: (client: RuntimeGateway) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await invoke(this.#client(owner.endpoint));
      await this.hooks.afterForward?.({ operation, owner });
      return result;
    } catch (error) {
      if (
        error instanceof RuntimeError &&
        error.code === "RUNTIME_UNAVAILABLE" &&
        isRuntimeConnectionFailure(error)
      ) {
        throw new RuntimeError(
          "OWNER_ROUTE_UNAVAILABLE",
          "The registered Runtime owner endpoint is unavailable",
          routeDetails(owner, operation, error.details),
          true,
        );
      }
      if (error instanceof RuntimeError && error.code === "DELIVERY_UNKNOWN") {
        throw new RuntimeError(
          "DELIVERY_UNKNOWN",
          error.message,
          routeDetails(owner, operation, error.details),
          error.retryable,
        );
      }
      throw error;
    }
  }

  #client(endpoint: string): RuntimeGateway {
    const existing = this.#clients.get(endpoint);
    if (existing !== undefined) return existing;
    const client = this.clientFactory(endpoint);
    this.#clients.set(endpoint, client);
    return client;
  }
}

function isRuntimeConnectionFailure(error: RuntimeError): boolean {
  return (
    typeof error.details.operation === "string" &&
    typeof error.details.reason === "string" &&
    typeof error.details.requestId === "string"
  );
}

export async function startRuntimeRouter(options: {
  readonly databaseStatementTimeoutMilliseconds?: number;
  readonly databaseUrl: string;
  readonly hooks?: RuntimeRouterHooks;
  readonly socketPath: string;
}): Promise<RuntimeRouterHandle> {
  if (!isAbsolute(options.socketPath)) {
    throw new RuntimeError("INVALID_REQUEST", "Runtime Router socket path must be absolute", {
      socketPath: options.socketPath,
    });
  }
  const routes = new PostgresRuntimeOwnerRegistry(options.databaseUrl, {
    ...(options.databaseStatementTimeoutMilliseconds === undefined
      ? {}
      : { statementTimeoutMilliseconds: options.databaseStatementTimeoutMilliseconds }),
  });
  let rpc: RuntimeRpcServerHandle | undefined;
  try {
    await routes.migrate();
    const gateway = new CentralRuntimeRouterGateway(routes, undefined, options.hooks);
    rpc = await startRuntimeRpcServer({ gateway, socketPath: options.socketPath });
    const rpcHandle = rpc;
    let closePromise: Promise<void> | undefined;
    return {
      gateway,
      socketPath: rpcHandle.socketPath,
      close: () => {
        closePromise ??= closeRuntimeRouter(rpcHandle, routes);
        return closePromise;
      },
    };
  } catch (error) {
    await rpc?.close().catch(() => undefined);
    await routes.close().catch(() => undefined);
    throw error;
  }
}

export function defaultRuntimeRouterSocketPath(): string {
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  const base =
    runtimeDirectory !== undefined && isAbsolute(runtimeDirectory) ? runtimeDirectory : tmpdir();
  const user = typeof process.getuid === "function" ? process.getuid().toString() : "local";
  return join(base, `iterminal-router-${user}.sock`);
}

async function closeRuntimeRouter(
  rpc: RuntimeRpcServerHandle,
  routes: PostgresRuntimeOwnerRegistry,
): Promise<void> {
  const errors: unknown[] = [];
  await rpc.close().catch((error: unknown) => errors.push(error));
  await routes.close().catch((error: unknown) => errors.push(error));
  if (errors.length > 0) throw new AggregateError(errors, "Runtime Router did not close cleanly");
}

function requiredRoute(
  resolution: RuntimeRouteResolution | undefined,
  targetKind: TargetKind,
  targetId: string,
  operation: string,
): RuntimeOwnerRoute {
  if (resolution === undefined) {
    throw new RuntimeError(
      targetKind === "session" ? "SESSION_NOT_FOUND" : "EXECUTION_NOT_FOUND",
      `${targetKind === "session" ? "Session" : "Execution"} does not exist`,
      { operation, targetId },
    );
  }
  if (resolution.liveOwner === undefined) {
    throw new RuntimeError(
      "OWNER_ROUTE_UNAVAILABLE",
      "The durable target has no live Runtime owner route",
      { operation, ownerId: resolution.ownerId, targetId, targetKind },
      true,
    );
  }
  return resolution.liveOwner;
}

function expectSessionOwner(
  session: Session,
  owner: RuntimeOwnerRoute,
  operation: string,
): Session {
  if (session.ownerId !== owner.ownerId) {
    throw new RuntimeError(
      "OWNER_ROUTE_UNAVAILABLE",
      "Runtime owner returned a Session belonging to another owner",
      {
        actualOwnerId: session.ownerId,
        expectedOwnerId: owner.ownerId,
        operation,
        ownerEpoch: owner.epoch,
        ownerInstanceId: owner.instanceId,
        sessionId: session.id,
      },
      false,
    );
  }
  return session;
}

function routeDetails(
  owner: RuntimeOwnerRoute,
  operation: string,
  cause: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    cause,
    endpoint: owner.endpoint,
    operation,
    ownerEpoch: owner.epoch,
    ownerId: owner.ownerId,
    ownerInstanceId: owner.instanceId,
  };
}
