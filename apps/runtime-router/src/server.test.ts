import type { RuntimeOwnerRecord, RuntimeOwnerRegistry } from "@iterminal/application";
import type { Session } from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { describe, expect, it } from "vitest";

import { CentralRuntimeRouterGateway } from "./server.js";

describe("CentralRuntimeRouterGateway error classification", () => {
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

function routeRegistry(liveOwner: RuntimeOwnerRecord): RuntimeOwnerRegistry {
  const unsupported = (): never => {
    throw new Error("Unexpected registry operation");
  };
  return {
    beginOwnerDrain: unsupported,
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
  endpoint: "/tmp/owner-route.sock",
  epoch: 4,
  heartbeatAt: new Date(0).toISOString(),
  instanceId: "instance-route",
  leaseExpiresAt: new Date(60_000).toISOString(),
  ownerId: "owner-route",
  startedAt: new Date(0).toISOString(),
  status: "ACTIVE",
  version: 2,
};
