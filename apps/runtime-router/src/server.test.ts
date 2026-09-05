import type {
  ActionLookupRequest,
  ActionLookupResult,
  ArtifactReadRequest,
  ArtifactReadResult,
  ExecutionObservationRequest,
  ExecutionObservationResult,
  ExecutionOutputReadRequest,
  ExecutionOutputReadResult,
  ExecutionWaitRequest,
  ExecutionWaitResult,
  HistoryLookupRequest,
  HistoryLookupResult,
  RuntimeOwnerRecord,
  RuntimeOwnerRegistry,
} from "@iterminal/application";
import type { Session, PendingApprovalsRequest, PendingApprovalsPage } from "@iterminal/domain";
import { RuntimeError, ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { UnixRuntimeClient, type RuntimeGateway } from "@iterminal/runtime-rpc";
import { describe, expect, it } from "vitest";

import { CentralRuntimeRouterGateway } from "./server.js";

describe("CentralRuntimeRouterGateway error classification", () => {
  it("reports Router features separately from each exact target owner", async () => {
    const secondOwner = { ...owner, endpoint: "/tmp/owner-route-2.sock", ownerId: "owner-route-2" };
    const owners = new Map([
      ["session-a", owner],
      ["session-b", secondOwner],
      ["session-legacy", owner],
    ]);
    const routes: RuntimeOwnerRegistry = {
      ...routeRegistry(owner),
      resolveSessionRoute: (sessionId) => {
        const liveOwner = owners.get(sessionId);
        return Promise.resolve(
          liveOwner === undefined ? undefined : { liveOwner, ownerId: liveOwner.ownerId },
        );
      },
    };
    const gateway = new CentralRuntimeRouterGateway(
      routes,
      (endpoint) => {
        if (endpoint === owner.endpoint) {
          return new CapabilityClient("owner-a", [
            "action.execute.v1",
            "artifact.read.v1",
            "execution.observe.v1",
            "execution.output.read.v1",
            "runtime.capabilities.v1",
          ]);
        }
        return new CapabilityClient("owner-b", ["action.input.v1", "runtime.capabilities.v1"]);
      },
      {},
      undefined,
      { buildId: "router-a05" },
    );

    await expect(gateway.getRuntimeCapabilities()).resolves.toEqual({
      buildId: "router-a05",
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
      protocolVersion: "1",
    });
    await expect(gateway.getRuntimeCapabilities({ sessionId: "session-a" })).resolves.toEqual({
      buildId: "owner-a",
      features: [
        "action.execute.v1",
        "artifact.read.v1",
        "execution.observe.v1",
        "execution.output.read.v1",
        "runtime.capabilities.v1",
      ],
      protocolVersion: "1",
    });
    await expect(gateway.getRuntimeCapabilities({ sessionId: "session-b" })).resolves.toEqual({
      buildId: "owner-b",
      features: ["action.input.v1", "runtime.capabilities.v1"],
      protocolVersion: "1",
    });

    const legacyGateway = new CentralRuntimeRouterGateway(
      routes,
      () => ({ getRuntimeCapabilities: undefined }) as unknown as RuntimeGateway,
    );
    await expect(
      legacyGateway.getRuntimeCapabilities({ sessionId: "session-legacy" }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "Target Runtime owner does not support capability negotiation",
    });
  });

  it("preserves an owner business RUNTIME_UNAVAILABLE response", async () => {
    const ownerFailure = new RuntimeError(
      "RUNTIME_UNAVAILABLE",
      "Owner durability circuit is open",
      { source: "owner-runtime" },
      true,
    );
    const gateway = new CentralRuntimeRouterGateway(
      routeRegistry(owner),
      () => new BusinessUnavailableClient(ownerFailure),
    );

    await expect(gateway.getSession("session-owner-unavailable")).rejects.toBe(ownerFailure);
  });

  it("routes Action lookup to one exact owner and classifies absent or unavailable routes", async () => {
    const request = {
      actor: {
        capabilities: ["session.execute"] as const,
        client: "router-test",
        id: "agent-router",
        principal: "router-principal",
        type: "agent" as const,
      },
      generation: 7,
      idempotencyKey: "router-lookup",
      sessionId: "session-routed",
    };
    let calls = 0;
    const routed = new CentralRuntimeRouterGateway(
      routeRegistry(owner),
      () =>
        new LookupClient((received) => {
          calls += 1;
          expect(received).toEqual(request);
          return Promise.resolve({
            acceptedAt: new Date(0).toISOString(),
            actionId: "action-routed",
            actionStatus: "COMPLETED",
            actionType: "execute",
            executionId: "execution-routed",
            executionStatus: "COMPLETED",
            generation: received.generation,
            idempotencyKey: received.idempotencyKey,
            kind: "found",
            sessionId: received.sessionId,
          });
        }),
    );
    await expect(routed.lookupAction(request)).resolves.toMatchObject({
      actionId: "action-routed",
      kind: "found",
    });
    expect(calls).toBe(1);

    const absent = new CentralRuntimeRouterGateway(
      { ...routeRegistry(owner), resolveSessionRoute: () => Promise.resolve(undefined) },
      () => new LookupClient(() => Promise.reject(new Error("must not dispatch"))),
    );
    await expect(absent.lookupAction(request)).resolves.toMatchObject({
      kind: "not_found",
      mayStillBeInFlight: true,
    });

    const ownerless = new CentralRuntimeRouterGateway(
      {
        ...routeRegistry(owner),
        resolveSessionRoute: () => Promise.resolve({ ownerId: owner.ownerId }),
      },
      () => new LookupClient(() => Promise.reject(new Error("must not dispatch"))),
    );
    await expect(ownerless.lookupAction(request)).resolves.toMatchObject({
      kind: "unavailable",
      reason: "owner_route_unavailable",
    });

    const databaseDown = new CentralRuntimeRouterGateway(
      {
        ...routeRegistry(owner),
        resolveSessionRoute: () => Promise.reject(new Error("route database down")),
      },
      () => new LookupClient(() => Promise.reject(new Error("must not dispatch"))),
    );
    await expect(databaseDown.lookupAction(request)).resolves.toMatchObject({
      kind: "unavailable",
      reason: "owner_route_unavailable",
    });

    const denied = new CentralRuntimeRouterGateway(
      routeRegistry(owner),
      () => new LookupClient(() => Promise.reject(new RuntimeError("POLICY_DENIED", "denied"))),
    );
    await expect(denied.lookupAction(request)).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it("routes durable history to one exact owner and preserves typed route failures", async () => {
    const request: HistoryLookupRequest = {
      actor: {
        capabilities: ["session.execute"],
        client: "router-test",
        id: "agent-router",
        principal: "router-principal",
        type: "agent",
      },
      generation: 7,
      sessionId: "session-routed",
      target: { executionId: "execution-routed", type: "execution" },
    };
    let calls = 0;
    const routed = new CentralRuntimeRouterGateway(
      routeRegistry(owner),
      () =>
        new HistoryClient((received) => {
          calls += 1;
          expect(received).toEqual(request);
          return Promise.resolve({
            fact: {
              acceptedAt: new Date(0).toISOString(),
              actionId: "action-routed",
              actionStatus: "COMPLETED",
              executionId: "execution-routed",
              executionStatus: "COMPLETED",
              targetType: "execution",
            },
            generation: received.generation,
            kind: "full",
            sessionId: received.sessionId,
            source: "durable",
            target: received.target,
          });
        }),
    );
    await expect(routed.lookupHistory(request)).resolves.toMatchObject({
      kind: "full",
      source: "durable",
    });
    expect(calls).toBe(1);

    const absent = new CentralRuntimeRouterGateway(
      { ...routeRegistry(owner), resolveSessionRoute: () => Promise.resolve(undefined) },
      () => new HistoryClient(() => Promise.reject(new Error("must not dispatch"))),
    );
    await expect(absent.lookupHistory(request)).resolves.toMatchObject({ kind: "not_found" });

    const unavailable = new CentralRuntimeRouterGateway(
      {
        ...routeRegistry(owner),
        resolveSessionRoute: () => Promise.resolve({ ownerId: owner.ownerId }),
      },
      () => new HistoryClient(() => Promise.reject(new Error("must not dispatch"))),
    );
    await expect(unavailable.lookupHistory(request)).resolves.toMatchObject({
      kind: "unavailable",
      reason: "owner_route_unavailable",
    });
  });

  it("routes Artifact reads by the claimed Session while preserving non-disclosing misses", async () => {
    const request = {
      artifactId: "art-routed",
      generation: 7,
      offsetBytes: 0,
      sessionId: "session-routed",
    };
    let calls = 0;
    const routed = new CentralRuntimeRouterGateway(
      routeRegistry(owner),
      () =>
        new ArtifactClient((received) => {
          calls += 1;
          expect(received).toEqual(request);
          return Promise.resolve({
            artifactId: received.artifactId,
            contentBase64: "eA==",
            contentType: "application/octet-stream",
            eof: true,
            generation: received.generation,
            kind: "found",
            nextOffset: 1,
            offsetBytes: 0,
            returnedBytes: 1,
            sessionId: received.sessionId,
            totalBytes: 1,
          });
        }),
    );
    await expect(routed.readArtifact(request)).resolves.toMatchObject({ kind: "found" });
    expect(calls).toBe(1);

    const absent = new CentralRuntimeRouterGateway(
      { ...routeRegistry(owner), resolveSessionRoute: () => Promise.resolve(undefined) },
      () => new ArtifactClient(() => Promise.reject(new Error("must not dispatch"))),
    );
    await expect(absent.readArtifact(request)).resolves.toMatchObject({ kind: "not_found" });
  });

  it("routes Execution output to one exact Session owner and hides absent routes", async () => {
    const request = {
      executionId: "execution-routed",
      generation: 7,
      sessionId: "session-routed",
    };
    let calls = 0;
    const routed = new CentralRuntimeRouterGateway(
      routeRegistry(owner),
      () =>
        new ExecutionOutputClient((received) => {
          calls += 1;
          return Promise.resolve({
            chunks: [],
            encoding: "base64",
            executionId: received.executionId,
            executionState: "RUNNING",
            gap: null,
            generation: received.generation,
            hasMore: false,
            persistenceLag: "possible",
            retention: { minimumAvailableSequence: 1, source: "durable" },
            sessionId: received.sessionId,
            stream: "pty",
          });
        }),
    );
    await expect(routed.readExecutionOutput(request)).resolves.toMatchObject({
      executionId: request.executionId,
      persistenceLag: "possible",
    });
    expect(calls).toBe(1);

    const absent = new CentralRuntimeRouterGateway(
      { ...routeRegistry(owner), resolveSessionRoute: () => Promise.resolve(undefined) },
      () => new ExecutionOutputClient(() => Promise.reject(new Error("must not dispatch"))),
    );
    await expect(absent.readExecutionOutput(request)).rejects.toMatchObject({
      code: "EXECUTION_NOT_FOUND",
    });
  });

  it("forwards one bounded wait to the exact Execution owner with the same cancellation", async () => {
    const request = { executionId: "execution-routed", waitMs: 30_000 };
    const controller = new AbortController();
    let calls = 0;
    const exactRoutes = {
      ...routeRegistry(owner),
      resolveExecutionRoute: (executionId: string) => {
        expect(executionId).toBe(request.executionId);
        return Promise.resolve({ liveOwner: owner, ownerId: owner.ownerId });
      },
    };
    const routed = new CentralRuntimeRouterGateway(
      exactRoutes,
      () =>
        new ExecutionWaitClient((received, signal) => {
          calls += 1;
          expect(received).toEqual(request);
          expect(signal).toBe(controller.signal);
          return Promise.resolve({
            completed: false,
            executionId: received.executionId,
            executionState: "RUNNING",
          });
        }),
    );

    await expect(routed.waitExecutionV2(request, controller.signal)).resolves.toEqual({
      completed: false,
      executionId: request.executionId,
      executionState: "RUNNING",
    });
    expect(calls).toBe(1);

    const absent = new CentralRuntimeRouterGateway(
      { ...exactRoutes, resolveExecutionRoute: () => Promise.resolve(undefined) },
      () => new ExecutionWaitClient(() => Promise.reject(new Error("must not dispatch"))),
    );
    await expect(absent.waitExecutionV2(request)).rejects.toMatchObject({
      code: "EXECUTION_NOT_FOUND",
    });

    const backendFailure = new RuntimeError(
      "RUNTIME_UNAVAILABLE",
      "Owner wait backend unavailable",
      { source: "owner-runtime" },
      true,
    );
    const unavailable = new CentralRuntimeRouterGateway(
      exactRoutes,
      () => new ExecutionWaitClient(() => Promise.reject(backendFailure)),
    );
    await expect(unavailable.waitExecutionV2(request)).rejects.toBe(backendFailure);
  });

  it("routes one composed observation to the exact Session owner without another wait budget", async () => {
    const request = {
      executionId: "execution-observe-routed",
      generation: 7,
      sessionId: "session-routed",
      waitMs: 30_000,
    };
    const controller = new AbortController();
    let calls = 0;
    const routed = new CentralRuntimeRouterGateway(
      routeRegistry(owner),
      () =>
        new ExecutionObservationClient((received, signal) => {
          calls += 1;
          expect(received).toEqual(request);
          expect(signal).toBe(controller.signal);
          return Promise.resolve({
            gap: null,
            identity: {
              executionId: received.executionId,
              generation: received.generation,
              sessionId: received.sessionId,
            },
            nextActions: ["wait_for_completion"],
            nextCursor: null,
            output: {
              byteLength: 0,
              contentBase64: "",
              encoding: "base64",
              hasMore: false,
              retention: { minimumAvailableSequence: 1, source: "durable" },
              stream: "pty",
              text: "",
              textStatus: "complete",
            },
            state: {
              completed: false,
              executionState: "RUNNING",
              persistenceLag: "possible",
            },
          });
        }),
    );

    await expect(routed.observeExecution(request, controller.signal)).resolves.toMatchObject({
      state: { completed: false, executionState: "RUNNING" },
    });
    expect(calls).toBe(1);

    const absent = new CentralRuntimeRouterGateway(
      { ...routeRegistry(owner), resolveSessionRoute: () => Promise.resolve(undefined) },
      () => new ExecutionObservationClient(() => Promise.reject(new Error("must not dispatch"))),
    );
    await expect(absent.observeExecution(request)).rejects.toMatchObject({
      code: "EXECUTION_NOT_FOUND",
    });

    const backendFailure = new RuntimeError(
      "RUNTIME_UNAVAILABLE",
      "Owner observation backend unavailable",
      { source: "owner-runtime" },
      true,
    );
    const unavailable = new CentralRuntimeRouterGateway(
      routeRegistry(owner),
      () => new ExecutionObservationClient(() => Promise.reject(backendFailure)),
    );
    await expect(unavailable.observeExecution(request)).rejects.toBe(backendFailure);
  });

  it("forwards bounded-wait abort without retrying or changing the Execution result", async () => {
    const controller = new AbortController();
    let calls = 0;
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const routed = new CentralRuntimeRouterGateway(
      {
        ...routeRegistry(owner),
        resolveExecutionRoute: () => Promise.resolve({ liveOwner: owner, ownerId: owner.ownerId }),
      },
      () =>
        new ExecutionWaitClient((_request, signal) => {
          calls += 1;
          return new Promise((_resolve, reject) => {
            announceStarted();
            signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("fixture observation aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          });
        }),
    );
    const waiting = routed.waitExecutionV2(
      { executionId: "execution-routed", waitMs: 30_000 },
      controller.signal,
    );
    await started;
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("rejects a Session returned under a conflicting owner identity", async () => {
    const gateway = new CentralRuntimeRouterGateway(
      routeRegistry(owner),
      () => new WrongOwnerClient(),
    );

    await expect(gateway.getSession("session-wrong-owner")).rejects.toMatchObject({
      code: "OWNER_ROUTE_UNAVAILABLE",
      details: {
        actualOwnerId: "owner-other",
        expectedOwnerId: owner.ownerId,
      },
      retryable: false,
    });
  });

  it("classifies route database failure before creating an owner client", async () => {
    let ownerClientCreated = false;
    const routes: RuntimeOwnerRegistry = {
      ...routeRegistry(owner),
      resolveSessionRoute: () => Promise.reject(new Error("database connection details")),
    };
    const gateway = new CentralRuntimeRouterGateway(routes, () => {
      ownerClientCreated = true;
      return new WrongOwnerClient();
    });

    await expect(gateway.getSession("session-database-partition")).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      details: {
        component: "runtime-router",
        operation: "session.get",
        phase: "route_resolution",
      },
      message: "Runtime Router durable route database is unavailable",
      retryable: true,
    });
    expect(ownerClientCreated).toBe(false);
  });
});

class BusinessUnavailableClient extends UnixRuntimeClient {
  public constructor(private readonly failure: RuntimeError) {
    super("/unused/business-unavailable.sock");
  }

  public override getSession(): Promise<Session> {
    return Promise.reject(this.failure);
  }
}

class WrongOwnerClient extends UnixRuntimeClient {
  public constructor() {
    super("/unused/wrong-owner.sock");
  }

  public override getSession(sessionId: string): Promise<Session> {
    return Promise.resolve({
      actionSequence: 0,
      createdAt: new Date(0).toISOString(),
      eventSequence: 0,
      generation: 1,
      id: sessionId,
      ownerId: "owner-other",
      screenVersion: 0,
      shell: "zsh",
      status: "READY",
      workspaceRoot: "/tmp",
    });
  }
}

class CapabilityClient extends UnixRuntimeClient {
  public constructor(
    private readonly buildId: string,
    private readonly features: readonly (
      | "action.execute.v1"
      | "action.input.v1"
      | "artifact.read.v1"
      | "execution.observe.v1"
      | "runtime.capabilities.v1"
      | "execution.output.read.v1"
      | "execution.wait.v2"
      | "history.lookup.v1"
    )[],
  ) {
    super("/unused/capability-owner.sock");
  }

  public override getRuntimeCapabilities() {
    return Promise.resolve({
      buildId: this.buildId,
      features: this.features,
      protocolVersion: "1",
    });
  }
}

class ExecutionOutputClient extends UnixRuntimeClient {
  public constructor(
    private readonly read: (
      request: ExecutionOutputReadRequest,
    ) => Promise<ExecutionOutputReadResult>,
  ) {
    super("/unused/execution-output-owner.sock");
  }

  public override readExecutionOutput(
    request: ExecutionOutputReadRequest,
  ): Promise<ExecutionOutputReadResult> {
    return this.read(request);
  }
}

class ExecutionObservationClient extends UnixRuntimeClient {
  public constructor(
    private readonly observe: (
      request: ExecutionObservationRequest,
      signal?: AbortSignal,
    ) => Promise<ExecutionObservationResult>,
  ) {
    super("/unused/execution-observation-owner.sock");
  }

  public override observeExecution(
    request: ExecutionObservationRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionObservationResult> {
    return this.observe(request, signal);
  }
}

class ExecutionWaitClient extends UnixRuntimeClient {
  public constructor(
    private readonly wait: (
      request: ExecutionWaitRequest,
      signal?: AbortSignal,
    ) => Promise<ExecutionWaitResult>,
  ) {
    super("/unused/execution-wait-owner.sock");
  }

  public override waitExecutionV2(
    request: ExecutionWaitRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionWaitResult> {
    return this.wait(request, signal);
  }
}

class ArtifactClient extends UnixRuntimeClient {
  public constructor(
    private readonly read: (request: ArtifactReadRequest) => Promise<ArtifactReadResult>,
  ) {
    super("/unused/artifact-read-owner.sock");
  }

  public override readArtifact(request: ArtifactReadRequest): Promise<ArtifactReadResult> {
    return this.read(request);
  }
}

class LookupClient extends UnixRuntimeClient {
  public constructor(
    private readonly lookup: (request: ActionLookupRequest) => Promise<ActionLookupResult>,
  ) {
    super("/unused/action-lookup-owner.sock");
  }

  public override lookupAction(request: ActionLookupRequest): Promise<ActionLookupResult> {
    return this.lookup(request);
  }
}

class HistoryClient extends UnixRuntimeClient {
  public constructor(
    private readonly lookup: (request: HistoryLookupRequest) => Promise<HistoryLookupResult>,
  ) {
    super("/unused/history-lookup-owner.sock");
  }

  public override lookupHistory(request: HistoryLookupRequest): Promise<HistoryLookupResult> {
    return this.lookup(request);
  }
}

function routeRegistry(liveOwner: RuntimeOwnerRecord): RuntimeOwnerRegistry {
  const unsupported = (): never => {
    throw new Error("Unexpected registry operation");
  };
  return {
    beginOwnerDrain: unsupported,
    claimAssignableOwner: unsupported,
    claimSessionCreation: unsupported,
    heartbeatOwner: unsupported,
    listAssignableOwners: unsupported,
    listSessionOwnerRoutes: unsupported,
    registerOwner: unsupported,
    resolveExecutionRoute: unsupported,
    resolveLiveOwner: unsupported,
    resolveSessionRoute: () => Promise.resolve({ liveOwner, ownerId: liveOwner.ownerId }),
    stopOwner: unsupported,
  };
}

const owner: RuntimeOwnerRecord = {
  activeSessionCount: 1,
  capacityWeight: 1,
  endpoint: "/tmp/owner-route.sock",
  epoch: 4,
  heartbeatAt: new Date(0).toISOString(),
  instanceId: "instance-route",
  leaseExpiresAt: new Date(60_000).toISOString(),
  ownerId: "owner-route",
  placementCount: 0,
  startedAt: new Date(0).toISOString(),
  status: "ACTIVE",
  version: 2,
};

describe("bounded discovery deadlines", () => {
  it("caps owner probes at four, cancels timed out requests, and retains a healthy and historical item", async () => {
    const healthyOwner = { ...owner, ownerId: "healthy", endpoint: "/tmp/healthy.sock" };
    const sessions = Array.from(
      { length: 6 },
      (_, index) =>
        ({ id: `bad-${index}`, generation: 1, ownerId: owner.ownerId, status: "READY" }) as Session,
    );
    const healthy = {
      id: "healthy",
      generation: 1,
      ownerId: healthyOwner.ownerId,
      status: "READY",
    } as Session;
    const historical = {
      id: "historical",
      generation: 1,
      ownerId: "gone",
      status: "BROKEN",
    } as Session;
    let active = 0,
      maximum = 0,
      calls = 0;
    const signals: AbortSignal[] = [];
    const routes = {
      ...routeRegistry(owner),
      listSessionCandidates: () =>
        Promise.resolve({
          items: [
            ...sessions.map((session) => ({
              session,
              route: { liveOwner: owner, ownerId: owner.ownerId },
            })),
            { session: healthy, route: { liveOwner: healthyOwner, ownerId: healthyOwner.ownerId } },
            { session: historical, route: { ownerId: "gone" } },
          ],
          nextCursor: null,
        }),
    };
    const gateway = new CentralRuntimeRouterGateway(
      routes,
      () =>
        new DiscoveryClient((id, signal) => {
          if (id === healthy.id) return Promise.resolve(healthy);
          if (!signal) throw new Error("Missing discovery cancellation signal");
          calls++;
          active++;
          maximum = Math.max(maximum, active);
          signals.push(signal);
          return new Promise<Session>((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => {
                active--;
                reject(new Error("fixture deadline"));
              },
              { once: true },
            ),
          );
        }),
    );
    const result = await gateway.listSessionsV2();
    expect(maximum).toBe(4);
    expect(calls).toBeLessThanOrEqual(4);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.items.find((item) => item.session.id === healthy.id)?.liveAvailability).toBe(
      "available",
    );
    expect(result.items.find((item) => item.session.id === historical.id)?.liveAvailability).toBe(
      "historical",
    );
  });

  it("starts a targeted inbox at that Session and aborts its timed-out owner request", async () => {
    const target = {
      id: "session-after-first-page",
      generation: 1,
      ownerId: owner.ownerId,
      status: "READY",
    } as Session;
    let signal: AbortSignal | undefined;
    let query: unknown;
    const gateway = new CentralRuntimeRouterGateway(
      {
        ...routeRegistry(owner),
        listSessionCandidates: (input) => {
          query = input;
          return Promise.resolve({
            items: [{ session: target, route: { liveOwner: owner, ownerId: owner.ownerId } }],
            nextCursor: "later-session",
          });
        },
      },
      () =>
        new DiscoveryClient(
          () => Promise.resolve(target),
          (_request, abort) => {
            signal = abort;
            return new Promise<PendingApprovalsPage>((_resolve, reject) =>
              abort?.addEventListener("abort", () => reject(new Error("fixture deadline")), {
                once: true,
              }),
            );
          },
        ),
    );
    const result = await gateway.listPendingApprovals({
      sessionId: target.id,
      actor: {
        id: "human-inbox",
        principal: "human-inbox",
        client: "fixture",
        type: "human",
        capabilities: ACTOR_CAPABILITY_PROFILES.human,
      },
    });
    expect(query).toEqual({ cursor: target.id, includeCursor: true, limit: 1 });
    expect(signal?.aborted).toBe(true);
    expect(result).toMatchObject({ partial: true, nextCursor: null, items: [] });
  });
  it("cancels a caller's inbox traversal instead of scanning further owners", async () => {
    const sessions = ["first", "second"].map(
      (id) => ({ id, generation: 1, ownerId: owner.ownerId, status: "READY" }) as Session,
    );
    let childSignal: AbortSignal | undefined;
    let probes = 0;
    const gateway = new CentralRuntimeRouterGateway(
      {
        ...routeRegistry(owner),
        listSessionCandidates: () =>
          Promise.resolve({
            items: sessions.map((session) => ({
              session,
              route: { liveOwner: owner, ownerId: owner.ownerId },
            })),
            nextCursor: null,
          }),
      },
      () =>
        new DiscoveryClient(
          () => Promise.resolve(sessions[0]!),
          (_request, signal) => {
            probes++;
            childSignal = signal;
            return new Promise<PendingApprovalsPage>(() => undefined);
          },
        ),
    );
    const caller = new AbortController();
    const pending = gateway.listPendingApprovals(
      {
        actor: {
          id: "human",
          principal: "human",
          client: "fixture",
          type: "human",
          capabilities: ACTOR_CAPABILITY_PROFILES.human,
        },
      },
      caller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => childSignal !== undefined).toBe(true);
    caller.abort();
    await rejected;
    expect(childSignal?.aborted).toBe(true);
    expect(probes).toBe(1);
  });
});

class DiscoveryClient extends UnixRuntimeClient {
  constructor(
    private readonly read: (id: string, signal?: AbortSignal) => Promise<Session>,
    private readonly pending?: (
      request: PendingApprovalsRequest,
      signal?: AbortSignal,
    ) => Promise<PendingApprovalsPage>,
  ) {
    super("/unused/discovery.sock");
  }
  override getSession(id: string, signal?: AbortSignal): Promise<Session> {
    return this.read(id, signal);
  }
  override listPendingApprovals(
    request: PendingApprovalsRequest,
    signal?: AbortSignal,
  ): Promise<PendingApprovalsPage> {
    if (!this.pending) throw new Error("Unexpected inbox probe");
    return this.pending(request, signal);
  }
}
