import type { RuntimeOwnerRecord, RuntimeOwnerRegistry } from "@iterminal/application";
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
          return new CapabilityClient("owner-a", ["action.execute.v1", "runtime.capabilities.v1"]);
        }
        return new CapabilityClient("owner-b", ["action.input.v1", "runtime.capabilities.v1"]);
      },
      {},
      undefined,
      { buildId: "router-a05" },
    );

    await expect(gateway.getRuntimeCapabilities()).resolves.toEqual({
      buildId: "router-a05",
      features: ["runtime.capabilities.v1", "runtime.owner-capabilities.v1"],
      protocolVersion: "1",
    });
    await expect(gateway.getRuntimeCapabilities({ sessionId: "session-a" })).resolves.toEqual({
      buildId: "owner-a",
      features: ["action.execute.v1", "runtime.capabilities.v1"],
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
      "action.execute.v1" | "action.input.v1" | "runtime.capabilities.v1"
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
