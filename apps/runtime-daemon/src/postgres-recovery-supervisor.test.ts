import type {
  RuntimeOwnerRecord,
  RuntimeOwnerRegistry,
  RuntimeService,
} from "@iterminal/application";
import { RuntimeError } from "@iterminal/domain";
import type { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { expect, it } from "vitest";

import { startPostgresRecoverySupervisor } from "./postgres-recovery-supervisor.js";

it("preserves an owner heartbeat lease error at the owner-supervision boundary", async () => {
  const owner: RuntimeOwnerRecord = {
    activeSessionCount: 0,
    capacityWeight: 1,
    endpoint: "/tmp/d01-owner.sock",
    epoch: 1,
    heartbeatAt: new Date().toISOString(),
    instanceId: "d01-owner-instance",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    ownerId: "d01-owner",
    placementCount: 0,
    startedAt: new Date().toISOString(),
    status: "ACTIVE",
    version: 1,
  };
  const ownerFailure = new RuntimeError(
    "OWNER_LEASE_LOST",
    "injected expired owner heartbeat",
    {},
    false,
  );
  let heartbeatCalls = 0;
  let durabilityHealthy = false;
  let reported: unknown;
  const durability = {
    databaseEndpointIndex: () => 0,
    healthCheck: () => Promise.resolve(),
    migrate: () => Promise.resolve(),
  } as unknown as PostgresRuntimeDurability;
  const registry = {
    heartbeatOwner: () => {
      heartbeatCalls += 1;
      return heartbeatCalls === 1 ? Promise.resolve(owner) : Promise.reject(ownerFailure);
    },
    registerOwner: () => Promise.resolve(owner),
  } as unknown as RuntimeOwnerRegistry;
  const runtime = {
    activateDurableOwner: () => undefined,
    isDurabilityHealthy: () => durabilityHealthy,
    recoverDurableOwner: () => {
      durabilityHealthy = true;
      return Promise.resolve({
        brokenSessions: 0,
        hydratedSessions: 0,
        unknownExecutions: 0,
      });
    },
    renewDurableSessionLeases: () => Promise.resolve(0),
    reportDurabilityUnavailable: (error: unknown) => {
      reported = error;
      durabilityHealthy = false;
    },
  } as unknown as RuntimeService;
  const supervisor = startPostgresRecoverySupervisor({
    durability,
    healthCheckMilliseconds: 1,
    initialDelayMilliseconds: 1,
    jitterRatio: 0,
    maxDelayMilliseconds: 1,
    ownership: {
      capacityWeight: 1,
      endpoint: owner.endpoint,
      instanceId: owner.instanceId,
      leaseMilliseconds: 60_000,
      ownerId: owner.ownerId,
      registry,
    },
    runtime,
    updateState: () => undefined,
  });
  try {
    await waitUntil(() => reported !== undefined);
    expect(reported).toBe(ownerFailure);
    expect(reported).toMatchObject({ code: "OWNER_LEASE_LOST", retryable: false });
  } finally {
    await supervisor.close();
  }
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Supervisor did not report the heartbeat failure");
}
