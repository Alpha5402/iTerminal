import type {
  ActionLookupRequest,
  ActionLookupResult,
  ArtifactReadRequest,
  ArtifactReadResult,
  RuntimeOwnerRecord,
  RuntimeOwnerRegistry,
} from "@iterminal/application";
import type { Session } from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";
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
        "artifact.read.v1",
        "runtime.capabilities.v1",
        "runtime.owner-capabilities.v1",
      ],
      protocolVersion: "1",
    });
    await expect(gateway.getRuntimeCapabilities({ sessionId: "session-a" })).resolves.toEqual({
      buildId: "owner-a",
      features: ["action.execute.v1", "artifact.read.v1", "runtime.capabilities.v1"],
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
      "action.execute.v1" | "action.input.v1" | "artifact.read.v1" | "runtime.capabilities.v1"
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
