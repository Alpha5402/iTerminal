import { pendingCursor, parsePendingCursor } from "@iterminal/application";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  sessionCreationRequestHash,
  type AcquireInteractionGuardRequest,
  type ActionLookupRequest,
  type ActionLookupResult,
  type ArtifactReadRequest,
  type ArtifactReadResult,
  type ExecutionObservationRequest,
  type ExecutionObservationResult,
  type ExecutionOutputReadRequest,
  type ExecutionOutputReadResult,
  type ExecutionWaitRequest,
  type ExecutionWaitResult,
  type ControlRequest,
  type BeginSecretInputRequest,
  type CreateSessionRequest,
  type DecideApprovalRequest,
  type ExecuteRequest,
  type ForkSessionRequest,
  type GetApprovalRequest,
  type InputRequest,
  type FinishSensitiveInputRequest,
  type GetSensitiveInputRequest,
  type HistoryLookupRequest,
  type HistoryLookupResult,
  type ListApprovalsRequest,
  type RequestExecuteApprovalRequest,
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
  Approval,
  ControlAction,
  EventPage,
  Execution,
  InputAction,
  InteractionState,
  ResizeAction,
  SecretInputAction,
  SensitiveInput,
  Session,
  SessionForkResult,
  ShellCheckpointView,
  TerminalScreenCellsResult,
  TerminalConsoleFrame,
  ConsoleObservation,
  TerminalHistoryPage,
  SessionDiscoveryPage,
  SessionDiscoveryRequest,
  PendingApprovalsRequest,
  PendingApprovalsPage,
  TerminalScreenDiffResult,
  TerminalScreenRegionResult,
  TerminalScreenSearchResult,
  TerminalScreenSnapshot,
  TerminalScreenWaitResult,
  TerminalStateObservation,
} from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";
import {
  defineRuntimeCapabilities,
  type RuntimeCapabilities,
  type RuntimeCapabilitiesRequest,
} from "@iterminal/protocol";
import {
  PostgresRuntimeOwnerRegistry,
  type PostgresConnectionTarget,
} from "@iterminal/persistence-postgres";
import {
  startRuntimeRpcServer,
  UnixRuntimeClient,
  type RuntimeRpcAuthentication,
  type RuntimeGateway,
  type RuntimeRpcServerHandle,
  type StartedExecutionView,
} from "@iterminal/runtime-rpc";

import {
  startRouterPostgresRecoverySupervisor,
  type RouterPostgresRecoverySupervisor,
  type RuntimeRouterDatabaseGate,
  type RuntimeRouterDatabaseState,
} from "./postgres-recovery-supervisor.js";

export interface RuntimeRouterHandle extends RuntimeRpcServerHandle {
  readonly gateway: CentralRuntimeRouterGateway;
  databaseState(): RuntimeRouterDatabaseState;
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
  readonly #capabilities: RuntimeCapabilities;

  public constructor(
    private readonly routes: RuntimeOwnerRegistry,
    private readonly clientFactory: (endpoint: string) => RuntimeGateway = (endpoint) =>
      new UnixRuntimeClient(endpoint),
    private readonly hooks: RuntimeRouterHooks = {},
    private readonly databaseGate?: RuntimeRouterDatabaseGate,
    options: Readonly<{ readonly buildId?: string }> = {},
  ) {
    this.#capabilities = defineRuntimeCapabilities({
      ...(options.buildId === undefined ? {} : { buildId: options.buildId }),
      features: [
        "action.lookup.v1",
        "approval.pending.list.v1",
        "artifact.read.v1",
        "execution.observe.v1",
        "execution.output.read.v1",
        "execution.wait.v2",
        "history.lookup.v1",
        "runtime.capabilities.v1",
        "runtime.owner-capabilities.v1",
        "session.list.v2",
      ],
    });
  }

  public async lookupAction(request: ActionLookupRequest): Promise<ActionLookupResult> {
    try {
      return await this.#withSession(request.sessionId, "action.lookup", (client) =>
        client.lookupAction(request),
      );
    } catch (error) {
      const identity = {
        generation: request.generation,
        idempotencyKey: request.idempotencyKey,
        sessionId: request.sessionId,
      };
      if (error instanceof RuntimeError && error.code === "SESSION_NOT_FOUND") {
        return {
          ...identity,
          kind: "not_found",
          mayStillBeInFlight: true,
          message:
            "No accepted Action is currently observable; the original request may still be in flight, so do not generate a replacement idempotency key",
        };
      }
      if (
        error instanceof RuntimeError &&
        (error.code === "RUNTIME_UNAVAILABLE" || error.code === "OWNER_ROUTE_UNAVAILABLE")
      ) {
        return {
          ...identity,
          kind: "unavailable",
          message: "The exact Runtime owner route is temporarily unavailable",
          reason: "owner_route_unavailable",
          retryable: true,
        };
      }
      throw error;
    }
  }

  public async lookupHistory(request: HistoryLookupRequest): Promise<HistoryLookupResult> {
    const identity = {
      generation: request.generation,
      sessionId: request.sessionId,
      target: request.target,
    };
    try {
      return await this.#withSession(request.sessionId, "history.lookup", (client) => {
        if (client.lookupHistory === undefined) {
          throw new RuntimeError(
            "RUNTIME_UNAVAILABLE",
            "Target Runtime owner does not support durable history lookup",
            { reason: "owner_capability_missing" },
            true,
          );
        }
        return client.lookupHistory(request);
      });
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "SESSION_NOT_FOUND") {
        return {
          ...identity,
          kind: "not_found",
          message: "No retained historical fact matches the exact Actor and Session scope",
        };
      }
      if (
        error instanceof RuntimeError &&
        (error.code === "RUNTIME_UNAVAILABLE" || error.code === "OWNER_ROUTE_UNAVAILABLE")
      ) {
        return {
          ...identity,
          kind: "unavailable",
          message: "The exact Runtime owner route is temporarily unavailable",
          reason: "owner_route_unavailable",
          retryable: true,
        };
      }
      throw error;
    }
  }

  public async readArtifact(request: ArtifactReadRequest): Promise<ArtifactReadResult> {
    try {
      return await this.#withSession(request.sessionId, "artifact.read", (client) =>
        client.readArtifact(request),
      );
    } catch (error) {
      const identity = {
        artifactId: request.artifactId,
        generation: request.generation,
        sessionId: request.sessionId,
      };
      if (error instanceof RuntimeError && error.code === "SESSION_NOT_FOUND") {
        return {
          ...identity,
          kind: "not_found",
          message: "Artifact is not available in the requested Session generation",
        };
      }
      if (
        error instanceof RuntimeError &&
        (error.code === "RUNTIME_UNAVAILABLE" || error.code === "OWNER_ROUTE_UNAVAILABLE")
      ) {
        return {
          ...identity,
          kind: "unavailable",
          message: "The exact Runtime owner route is temporarily unavailable",
          reason: "owner_route_unavailable",
          retryable: true,
        };
      }
      throw error;
    }
  }

  public async readExecutionOutput(
    request: ExecutionOutputReadRequest,
  ): Promise<ExecutionOutputReadResult> {
    try {
      return await this.#withSession(request.sessionId, "execution.output.read", (client) =>
        client.readExecutionOutput(request),
      );
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "SESSION_NOT_FOUND") {
        throw new RuntimeError(
          "EXECUTION_NOT_FOUND",
          "Execution was not found in the requested scope",
        );
      }
      throw error;
    }
  }

  public async observeExecution(
    request: ExecutionObservationRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionObservationResult> {
    try {
      return await this.#withSession(request.sessionId, "execution.observe", (client) => {
        if (client.observeExecution === undefined) {
          throw new RuntimeError(
            "INVALID_REQUEST",
            "Target Runtime owner does not support compact Execution observation",
          );
        }
        return client.observeExecution(request, signal);
      });
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "SESSION_NOT_FOUND") {
        throw new RuntimeError(
          "EXECUTION_NOT_FOUND",
          "Execution was not found in the requested scope",
        );
      }
      throw error;
    }
  }

  public getRuntimeCapabilities(
    request: RuntimeCapabilitiesRequest = {},
  ): Promise<RuntimeCapabilities> {
    if (request.sessionId === undefined) return Promise.resolve(this.#capabilities);
    return this.#withSession(request.sessionId, "runtime.capabilities", (client) => {
      if (client.getRuntimeCapabilities === undefined) {
        throw new RuntimeError(
          "INVALID_REQUEST",
          "Target Runtime owner does not support capability negotiation",
          { sessionId: request.sessionId },
        );
      }
      return client.getRuntimeCapabilities({});
    });
  }

  public requestExecuteApproval(request: RequestExecuteApprovalRequest): Promise<Approval> {
    return this.#withSession(request.sessionId, "approval.request", (client) =>
      client.requestExecuteApproval(request),
    );
  }

  public getApproval(request: GetApprovalRequest): Promise<Approval> {
    return this.#withSession(request.sessionId, "approval.get", (client) =>
      client.getApproval(request),
    );
  }

  public listApprovals(request: ListApprovalsRequest): Promise<readonly Approval[]> {
    return this.#withSession(request.sessionId, "approval.list", (client) =>
      client.listApprovals(request),
    );
  }

  public decideApproval(request: DecideApprovalRequest): Promise<Approval> {
    return this.#withSession(request.sessionId, "approval.decide", (client) =>
      client.decideApproval(request),
    );
  }

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

  public async getSession(sessionId: string, signal?: AbortSignal): Promise<Session> {
    const routed = await this.#withSessionRoute(sessionId, "session.get", (client) =>
      client.getSession(sessionId, signal),
    );
    return expectSessionOwner(routed.result, routed.owner, "session.get");
  }

  public async listPendingApprovals(
    request: PendingApprovalsRequest,
    signal?: AbortSignal,
  ): Promise<PendingApprovalsPage> {
    signal?.throwIfAborted();
    if (request.actor.type !== "human" || !request.actor.capabilities.includes("approval.decide"))
      throw new RuntimeError("POLICY_DENIED", "Only authorized Humans may read the Approval inbox");
    if (this.routes.listSessionCandidates === undefined)
      throw new RuntimeError("INVALID_REQUEST", "Registry does not support bounded discovery");
    const after = parsePendingCursor(request.cursor);
    const limit = request.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new RuntimeError("INVALID_REQUEST", "Invalid pending Approval limit");
    const candidates = await this.#routeDatabase("approval.pending.list", () =>
      this.routes.listSessionCandidates!({
        cursor: request.sessionId ?? after?.[0],
        includeCursor: true,
        limit: request.sessionId ? 1 : 50,
      }),
    );
    const items: Approval[] = [];
    const unavailable = new Set<string>();
    let scannedSession: string | undefined;
    for (const { session, route } of candidates.items) {
      signal?.throwIfAborted();
      scannedSession = session.id;
      if (request.sessionId && request.sessionId !== session.id) continue;
      if (session.status === "BROKEN" || session.status === "CLOSED") continue;
      if (!route.liveOwner || unavailable.has(session.ownerId)) {
        unavailable.add(session.ownerId);
        continue;
      }
      try {
        const page = await discoveryDeadline(
          (probeSignal) =>
            this.#forward(route.liveOwner!, "approval.pending.list", (client) => {
              if (!client.listPendingApprovals)
                throw new RuntimeError(
                  "INVALID_REQUEST",
                  "Owner does not support pending Approvals",
                );
              return client.listPendingApprovals(
                { ...request, sessionId: session.id, limit: limit - items.length },
                probeSignal,
              );
            }),
          signal,
        );
        items.push(...page.items);
        const last = items.at(-1);
        if (last && (page.nextCursor || items.length === limit))
          return {
            items,
            partial: unavailable.size > 0,
            unavailableOwners: [...unavailable],
            nextCursor: pendingCursor(last.sessionId, last.id),
          };
      } catch {
        signal?.throwIfAborted();
        unavailable.add(session.ownerId);
      }
    }
    return {
      items,
      partial: unavailable.size > 0,
      unavailableOwners: [...unavailable],
      nextCursor:
        !request.sessionId && candidates.nextCursor && scannedSession
          ? pendingCursor(scannedSession, "~")
          : null,
    };
  }

  public async listSessionsV2(
    request: SessionDiscoveryRequest = {},
  ): Promise<SessionDiscoveryPage> {
    if (this.routes.listSessionCandidates === undefined)
      throw new RuntimeError("INVALID_REQUEST", "Registry does not support bounded discovery");
    const page = await this.#routeDatabase("session.list.v2", () =>
      this.routes.listSessionCandidates!(request),
    );
    const items: SessionDiscoveryPage["items"][number][] = new Array<
      SessionDiscoveryPage["items"][number]
    >(page.items.length);
    const unavailable = new Set<string>();
    let offset = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, page.items.length) }, async () => {
        while (offset < page.items.length) {
          const index = offset++;
          const candidate = page.items[index]!;
          const { session, route } = candidate;
          let item: SessionDiscoveryPage["items"][number] = {
            session,
            durableStatus: session.status,
            liveAvailability: "unavailable",
          };
          if (session.status === "BROKEN" || session.status === "CLOSED")
            item = { ...item, liveAvailability: "historical" };
          else if (route.liveOwner && !unavailable.has(session.ownerId)) {
            try {
              const live = await discoveryDeadline((signal) =>
                this.#forward(route.liveOwner!, "session.get", (client) =>
                  client.getSession(session.id, signal),
                ),
              );
              if (live.ownerId !== session.ownerId || live.generation !== session.generation)
                item = { ...item, liveAvailability: "conflict" };
              else item = { ...item, session: live, liveAvailability: "available" };
            } catch {
              /* Explicit unavailable item retains only durable facts. */
            }
          }
          if (item.liveAvailability === "unavailable" || item.liveAvailability === "conflict")
            unavailable.add(session.ownerId);
          items[index] = item;
        }
      }),
    );
    return {
      items,
      nextCursor: page.nextCursor,
      partial: unavailable.size > 0,
      unavailableOwners: [...unavailable].sort(),
    };
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

  public getScreenHistory(request: {
    sessionId: string;
    generation: number;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<TerminalHistoryPage> {
    return this.#withSession(request.sessionId, "screen.history", (client) => {
      if (client.getScreenHistory === undefined)
        throw new RuntimeError("INVALID_REQUEST", "Screen history is unavailable");
      return client.getScreenHistory(request);
    });
  }

  public observeConsole(request: {
    sessionId: string;
    generation: number;
    afterScreenVersion?: number | undefined;
  }): Promise<ConsoleObservation> {
    return this.#withSession(request.sessionId, "console.observe", (client) => {
      if (!client.observeConsole)
        throw new RuntimeError("INVALID_REQUEST", "Owner does not support Console observation");
      return client.observeConsole(request);
    });
  }

  public getConsoleFrame(sessionId: string, generation: number): Promise<TerminalConsoleFrame> {
    return this.#withSession(sessionId, "screen.frame", (client) => {
      if (client.getConsoleFrame === undefined)
        throw new RuntimeError("INVALID_REQUEST", "Canonical Console cells are unavailable");
      return client.getConsoleFrame(sessionId, generation);
    });
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

  public waitExecutionV2(
    request: ExecutionWaitRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionWaitResult> {
    return this.#withExecution(request.executionId, "execution.wait.v2", (client) => {
      if (client.waitExecutionV2 === undefined) {
        throw new RuntimeError(
          "INVALID_REQUEST",
          "Target Runtime owner does not support bounded Execution wait",
        );
      }
      return client.waitExecutionV2(request, signal);
    });
  }

  public sendInput(request: InputRequest): Promise<InputAction> {
    return this.#withSession(request.sessionId, "input.send", (client) =>
      client.sendInput(request),
    );
  }

  public beginSecretInput(request: BeginSecretInputRequest): Promise<SecretInputAction> {
    return this.#withSession(request.sessionId, "secret.input.begin", (client) =>
      client.beginSecretInput(request),
    );
  }

  public getSensitiveInput(request: GetSensitiveInputRequest): Promise<SensitiveInput | undefined> {
    return this.#withSession(request.sessionId, "secret.input.get", (client) =>
      client.getSensitiveInput(request),
    );
  }

  public finishSensitiveInput(request: FinishSensitiveInputRequest): Promise<SensitiveInput> {
    return this.#withSession(request.sessionId, "secret.input.finish", (client) =>
      client.finishSensitiveInput(request),
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
    signal?: AbortSignal,
  ): Promise<EventPage> {
    return this.#withSession(sessionId, "events.query", (client) =>
      client.queryEvents(sessionId, generation, after, limit, signal),
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
      this.databaseGate?.assertReady(operation);
      return await query();
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      this.databaseGate?.reportUnavailable();
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
  readonly buildId?: string;
  readonly databaseHealthCheckMilliseconds?: number;
  readonly databaseReconnectInitialMilliseconds?: number;
  readonly databaseReconnectMaxMilliseconds?: number;
  readonly databaseStatementTimeoutMilliseconds?: number;
  readonly databaseUrl: PostgresConnectionTarget;
  readonly hooks?: RuntimeRouterHooks;
  readonly onDatabaseState?: (state: RuntimeRouterDatabaseState) => void;
  readonly rpcAuthentication?: RuntimeRpcAuthentication;
  readonly socketPath: string;
  readonly superviseDatabase?: boolean;
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
  let supervisor: RouterPostgresRecoverySupervisor | undefined;
  try {
    if (options.superviseDatabase === true) {
      supervisor = startRouterPostgresRecoverySupervisor({
        database: routes,
        ...(options.databaseHealthCheckMilliseconds === undefined
          ? {}
          : { healthCheckMilliseconds: options.databaseHealthCheckMilliseconds }),
        ...(options.databaseReconnectInitialMilliseconds === undefined
          ? {}
          : { initialDelayMilliseconds: options.databaseReconnectInitialMilliseconds }),
        ...(options.databaseReconnectMaxMilliseconds === undefined
          ? {}
          : { maxDelayMilliseconds: options.databaseReconnectMaxMilliseconds }),
        ...(options.onDatabaseState === undefined ? {} : { updateState: options.onDatabaseState }),
      });
    } else {
      await routes.migrate();
    }
    const gateway = new CentralRuntimeRouterGateway(
      routes,
      undefined,
      options.hooks,
      supervisor?.gate,
      { ...(options.buildId === undefined ? {} : { buildId: options.buildId }) },
    );
    rpc = await startRuntimeRpcServer({
      ...(options.rpcAuthentication === undefined
        ? {}
        : { authentication: options.rpcAuthentication }),
      gateway,
      socketPath: options.socketPath,
    });
    const rpcHandle = rpc;
    const databaseSupervisor = supervisor;
    let closePromise: Promise<void> | undefined;
    return {
      gateway,
      socketPath: rpcHandle.socketPath,
      databaseState: () => databaseSupervisor?.state() ?? { attempt: 0, phase: "READY" },
      close: () => {
        closePromise ??= closeRuntimeRouter(rpcHandle, routes, databaseSupervisor);
        return closePromise;
      },
    };
  } catch (error) {
    await rpc?.close().catch(() => undefined);
    await supervisor?.close().catch(() => undefined);
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
  supervisor?: RouterPostgresRecoverySupervisor,
): Promise<void> {
  const errors: unknown[] = [];
  await rpc.close().catch((error: unknown) => errors.push(error));
  await supervisor?.close().catch((error: unknown) => errors.push(error));
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

async function discoveryDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  parent?.throwIfAborted();
  const abort = new AbortController();
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => {
      abort.abort();
      const reason: unknown = parent?.reason;
      reject(reason instanceof Error ? reason : new Error("Discovery cancelled"));
    };
    parent?.addEventListener("abort", cancel, { once: true });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      cancelled,
      read(abort.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new RuntimeError("OWNER_ROUTE_UNAVAILABLE", "Discovery owner read timed out"));
        }, 2_000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
  }
}
