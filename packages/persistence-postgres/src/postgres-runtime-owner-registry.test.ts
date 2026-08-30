import { randomUUID } from "node:crypto";

import type { DurableSessionEvent } from "@iterminal/application";
import type { Session } from "@iterminal/domain";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresRuntimeDurability } from "./postgres-runtime-durability.js";
import { PostgresRuntimeOwnerRegistry } from "./postgres-runtime-owner-registry.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("M9.1 PostgreSQL Runtime owner registry", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const registries: PostgresRuntimeOwnerRegistry[] = [];

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M9 tests refuse to mutate any database except iterminal_test");
    }
    const migrator = createRegistry();
    await migrator.migrate();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox, runtime_workers RESTART IDENTITY CASCADE");
    await pool.query(
      `UPDATE session_creation_policies
          SET retention_milliseconds = 86400000,
              max_requests = 100000,
              cleanup_batch_size = 1000,
              updated_at = now()
        WHERE scope = 'default'`,
    );
  });

  afterEach(async () => {
    for (const registry of registries.splice(0)) await registry.close().catch(() => undefined);
  });

  afterAll(async () => pool.end());

  it("registers, heartbeats, drains, stops, and replaces one logical owner", async () => {
    const registry = createRegistry();
    const first = await registry.registerOwner({
      endpoint: "/tmp/iterminal-owner-a.sock",
      instanceId: "instance-a",
      leaseMilliseconds: 5_000,
      ownerId: "owner-a",
    });
    expect(first).toMatchObject({
      activeSessionCount: 0,
      endpoint: "/tmp/iterminal-owner-a.sock",
      epoch: 1,
      instanceId: "instance-a",
      ownerId: "owner-a",
      placementCount: 0,
      status: "ACTIVE",
      version: 1,
    });
    expect(await registry.listAssignableOwners()).toEqual([first]);
    const idempotentRegistration = await registry.registerOwner({
      endpoint: "/tmp/iterminal-owner-a.sock",
      instanceId: "instance-a",
      leaseMilliseconds: 5_000,
      ownerId: "owner-a",
    });
    expect(idempotentRegistration).toMatchObject({
      epoch: 1,
      startedAt: first.startedAt,
      status: "ACTIVE",
      version: 2,
    });

    await expect(
      registry.registerOwner({
        endpoint: "/tmp/iterminal-owner-b.sock",
        instanceId: "instance-b",
        leaseMilliseconds: 5_000,
        ownerId: "owner-a",
      }),
    ).rejects.toMatchObject({ code: "OWNER_CONFLICT" });

    const heartbeat = await registry.heartbeatOwner(idempotentRegistration, 5_000);
    expect(heartbeat).toMatchObject({ epoch: 1, status: "ACTIVE", version: 3 });
    const draining = await registry.beginOwnerDrain(heartbeat, 5_000);
    expect(draining).toMatchObject({ epoch: 1, status: "DRAINING", version: 4 });
    expect(await registry.listAssignableOwners()).toEqual([]);
    expect(await registry.resolveLiveOwner("owner-a")).toMatchObject({ status: "DRAINING" });
    const drainingHeartbeat = await registry.heartbeatOwner(draining, 5_000);
    expect(drainingHeartbeat).toMatchObject({ status: "DRAINING", version: 5 });

    const stopped = await registry.stopOwner(drainingHeartbeat);
    expect(stopped).toMatchObject({ epoch: 1, status: "STOPPED", version: 6 });
    expect(stopped.stoppedAt).toBeDefined();
    expect(await registry.resolveLiveOwner("owner-a")).toBeUndefined();

    const replacement = await registry.registerOwner({
      endpoint: "/tmp/iterminal-owner-b.sock",
      instanceId: "instance-b",
      leaseMilliseconds: 5_000,
      ownerId: "owner-a",
    });
    expect(replacement).toMatchObject({
      epoch: 2,
      instanceId: "instance-b",
      status: "ACTIVE",
      version: 7,
    });
    await expect(registry.heartbeatOwner(first, 5_000)).rejects.toMatchObject({
      code: "OWNER_LEASE_LOST",
    });
    await expect(registry.beginOwnerDrain(first, 5_000)).rejects.toMatchObject({
      code: "OWNER_LEASE_LOST",
    });
    await expect(registry.stopOwner(first)).rejects.toMatchObject({
      code: "OWNER_LEASE_LOST",
    });
  });

  it("allows only one replacement to win after database-time lease expiry", async () => {
    const firstRegistry = createRegistry();
    const secondRegistry = createRegistry();
    const thirdRegistry = createRegistry();
    const first = await firstRegistry.registerOwner({
      endpoint: "/tmp/iterminal-expiring-a.sock",
      instanceId: "expiring-a",
      leaseMilliseconds: 30,
      ownerId: "owner-expiring",
    });
    await delay(100);
    expect(await firstRegistry.listAssignableOwners()).toEqual([]);
    expect(await firstRegistry.resolveLiveOwner("owner-expiring")).toBeUndefined();

    const contenders = await Promise.allSettled([
      secondRegistry.registerOwner({
        endpoint: "/tmp/iterminal-expiring-b.sock",
        instanceId: "expiring-b",
        leaseMilliseconds: 5_000,
        ownerId: "owner-expiring",
      }),
      thirdRegistry.registerOwner({
        endpoint: "/tmp/iterminal-expiring-c.sock",
        instanceId: "expiring-c",
        leaseMilliseconds: 5_000,
        ownerId: "owner-expiring",
      }),
    ]);
    const fulfilled = contenders.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof firstRegistry.registerOwner>>
      > => result.status === "fulfilled",
    );
    const rejected = contenders.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value).toMatchObject({ epoch: 2, status: "ACTIVE" });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "OWNER_CONFLICT" });
    await expect(firstRegistry.heartbeatOwner(first, 5_000)).rejects.toMatchObject({
      code: "OWNER_LEASE_LOST",
    });
  });

  it("rejects expired lifecycle updates before controlled same-instance recovery", async () => {
    const registry = createRegistry();
    const first = await registry.registerOwner({
      endpoint: "/tmp/iterminal-expired-lifecycle.sock",
      instanceId: "expired-lifecycle-a",
      leaseMilliseconds: 40,
      ownerId: "owner-expired-lifecycle",
    });
    await delay(120);
    const before = await pool.query<{ lease_expires_at: Date; status: string; version: string }>(
      `SELECT lease_expires_at, status, version::text
         FROM runtime_workers WHERE owner_id = $1`,
      [first.ownerId],
    );

    await expect(registry.heartbeatOwner(first, 5_000)).rejects.toMatchObject({
      code: "OWNER_LEASE_LOST",
      retryable: false,
    });
    await expect(registry.beginOwnerDrain(first, 5_000)).rejects.toMatchObject({
      code: "OWNER_LEASE_LOST",
      retryable: false,
    });
    await expect(registry.stopOwner(first)).rejects.toMatchObject({
      code: "OWNER_LEASE_LOST",
      retryable: false,
    });
    const after = await pool.query<{ lease_expires_at: Date; status: string; version: string }>(
      `SELECT lease_expires_at, status, version::text
         FROM runtime_workers WHERE owner_id = $1`,
      [first.ownerId],
    );
    expect(after.rows).toEqual(before.rows);

    const recovered = await registry.registerOwner({
      endpoint: first.endpoint,
      instanceId: first.instanceId,
      leaseMilliseconds: 5_000,
      ownerId: first.ownerId,
    });
    expect(recovered).toMatchObject({
      epoch: first.epoch,
      instanceId: first.instanceId,
      status: "ACTIVE",
      version: first.version + 1,
    });
    await registry.stopOwner(recovered);
  });

  it("atomically distributes concurrent placement claims and excludes draining owners", async () => {
    const registry = createRegistry();
    const claimers = [registry, createRegistry(), createRegistry(), createRegistry()];
    const registrations = await Promise.all(
      ["a", "b", "c"].map((suffix) =>
        registry.registerOwner({
          endpoint: `/tmp/iterminal-placement-${suffix}.sock`,
          instanceId: `placement-${suffix}`,
          leaseMilliseconds: 5_000,
          ownerId: `owner-placement-${suffix}`,
        }),
      ),
    );

    const firstWave = await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const claimer = claimers[index % claimers.length];
        if (claimer === undefined) throw new Error("Placement claimer is missing");
        return claimer.claimAssignableOwner();
      }),
    );
    expect(firstWave.every((owner) => owner !== undefined)).toBe(true);
    expect(ownerCounts(firstWave)).toEqual({
      "owner-placement-a": 4,
      "owner-placement-b": 4,
      "owner-placement-c": 4,
    });

    const middle = registrations[1];
    if (middle === undefined) throw new Error("Middle placement owner is missing");
    await registry.beginOwnerDrain(middle, 5_000);
    const secondWave = await Promise.all(
      Array.from({ length: 6 }, (_, index) => {
        const claimer = claimers[index % claimers.length];
        if (claimer === undefined) throw new Error("Placement claimer is missing");
        return claimer.claimAssignableOwner();
      }),
    );
    expect(ownerCounts(secondWave)).toEqual({
      "owner-placement-a": 3,
      "owner-placement-c": 3,
    });
    expect(await registry.listAssignableOwners()).toEqual([
      expect.objectContaining({ ownerId: "owner-placement-a", placementCount: 7 }),
      expect.objectContaining({ ownerId: "owner-placement-c", placementCount: 7 }),
    ]);
  });

  it("claims one exact owner once for concurrent idempotent Session creation", async () => {
    const registry = createRegistry();
    const otherRouter = createRegistry();
    await Promise.all(
      ["a", "b"].map((suffix) =>
        registry.registerOwner({
          endpoint: `/tmp/iterminal-create-${suffix}.sock`,
          instanceId: `create-${suffix}`,
          leaseMilliseconds: 5_000,
          ownerId: `owner-create-${suffix}`,
        }),
      ),
    );
    const request = {
      idempotencyKey: "session-create-once",
      requestHash: "a".repeat(64),
    } as const;

    const claims = await Promise.all([
      registry.claimSessionCreation(request),
      otherRouter.claimSessionCreation(request),
    ]);
    expect(claims.map((claim) => claim?.owner.ownerId)).toEqual([
      "owner-create-a",
      "owner-create-a",
    ]);
    expect(await registry.listAssignableOwners()).toEqual([
      expect.objectContaining({ ownerId: "owner-create-b", placementCount: 0 }),
      expect.objectContaining({ ownerId: "owner-create-a", placementCount: 1 }),
    ]);
    await expect(
      otherRouter.claimSessionCreation({
        ...request,
        requestHash: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    const firstOwner = await registry.resolveLiveOwner("owner-create-a");
    if (firstOwner === undefined) throw new Error("First creation owner is missing");
    await registry.stopOwner(firstOwner);
    await expect(otherRouter.claimSessionCreation(request)).rejects.toMatchObject({
      code: "OWNER_ROUTE_UNAVAILABLE",
      details: { ownerId: "owner-create-a" },
    });
  });

  it("serializes distinct creation keys against one database capacity", async () => {
    await pool.query(
      `UPDATE session_creation_policies
          SET max_requests = 2, cleanup_batch_size = 2
        WHERE scope = 'default'`,
    );
    const registriesForClaims = [
      createRegistry(),
      createRegistry(),
      createRegistry(),
      createRegistry(),
    ];
    await registriesForClaims[0]?.registerOwner({
      endpoint: "/tmp/iterminal-capacity.sock",
      instanceId: "capacity-instance",
      leaseMilliseconds: 5_000,
      ownerId: "owner-capacity",
    });
    const claims = await Promise.allSettled(
      registriesForClaims.map((registry, index) =>
        registry.claimSessionCreation({
          idempotencyKey: `capacity-key-${index.toString()}`,
          requestHash: index.toString().padStart(64, "0"),
        }),
      ),
    );
    const accepted = claims.filter((result) => result.status === "fulfilled");
    const rejected = claims.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(2);
    for (const result of rejected) {
      expect(result.reason).toMatchObject({
        code: "BACKPRESSURE",
        details: {
          currentRequests: 2,
          limit: 2,
          phase: "idempotency_admission",
        },
        retryable: true,
      });
    }
    expect(await pool.query("SELECT 1 FROM session_creation_requests")).toMatchObject({
      rowCount: 2,
    });
    expect(await registriesForClaims[0]?.listAssignableOwners()).toEqual([
      expect.objectContaining({ ownerId: "owner-capacity", placementCount: 2 }),
    ]);
  });

  it("reclaims an expired unfinished key only after its exact owner is not live", async () => {
    await pool.query(
      `UPDATE session_creation_policies
          SET retention_milliseconds = 25, max_requests = 1, cleanup_batch_size = 1
        WHERE scope = 'default'`,
    );
    const registry = createRegistry();
    const firstOwner = await registry.registerOwner({
      endpoint: "/tmp/iterminal-retention-a.sock",
      instanceId: "retention-instance-a",
      leaseMilliseconds: 5_000,
      ownerId: "owner-retention-a",
    });
    await registry.claimSessionCreation({
      idempotencyKey: "retention-stale-key",
      requestHash: "a".repeat(64),
    });
    await delay(50);
    await expect(
      registry.claimSessionCreation({
        idempotencyKey: "retention-blocked-key",
        requestHash: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "BACKPRESSURE" });

    await registry.stopOwner(firstOwner);
    await registry.registerOwner({
      endpoint: "/tmp/iterminal-retention-b.sock",
      instanceId: "retention-instance-b",
      leaseMilliseconds: 5_000,
      ownerId: "owner-retention-b",
    });
    const reclaimed = await registry.claimSessionCreation({
      idempotencyKey: "retention-reclaimed-key",
      requestHash: "c".repeat(64),
    });
    expect(reclaimed?.owner.ownerId).toBe("owner-retention-b");
    const retained = await pool.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM session_creation_requests ORDER BY idempotency_key",
    );
    expect(retained.rows).toEqual([{ idempotency_key: "retention-reclaimed-key" }]);
  });

  it("applies the same capacity to direct durable Runtime fallback creation", async () => {
    await pool.query(
      `UPDATE session_creation_policies
          SET max_requests = 1, cleanup_batch_size = 1
        WHERE scope = 'default'`,
    );
    const registry = createRegistry();
    const owner = await registry.registerOwner({
      endpoint: "/tmp/iterminal-direct-capacity.sock",
      instanceId: "direct-capacity-instance",
      leaseMilliseconds: 5_000,
      ownerId: "owner-direct-capacity",
    });
    const durability = new PostgresRuntimeDurability(databaseUrl ?? "");
    try {
      const first = sessionFixture(owner.ownerId);
      await durability.createSession(
        first,
        [eventFixture(first)],
        owner,
        5_000,
        creationFixture(first),
      );
      const blocked = sessionFixture(owner.ownerId);
      await expect(
        durability.createSession(
          blocked,
          [eventFixture(blocked)],
          owner,
          5_000,
          creationFixture(blocked),
        ),
      ).rejects.toMatchObject({
        code: "BACKPRESSURE",
        details: { currentRequests: 1, limit: 1 },
      });
      expect(await pool.query("SELECT 1 FROM session_creation_requests")).toMatchObject({
        rowCount: 1,
      });
      expect(await pool.query("SELECT 1 FROM sessions")).toMatchObject({ rowCount: 1 });
    } finally {
      await durability.close();
    }
  });

  function createRegistry(): PostgresRuntimeOwnerRegistry {
    const registry = new PostgresRuntimeOwnerRegistry(databaseUrl ?? "");
    registries.push(registry);
    return registry;
  }
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function sessionFixture(ownerId: string): Session {
  return {
    actionSequence: 0,
    createdAt: new Date().toISOString(),
    eventSequence: 0,
    generation: 1,
    id: `ses_${randomUUID()}`,
    ownerId,
    screenVersion: 0,
    shell: "zsh",
    status: "STARTING",
    workspaceRoot: "/tmp",
  };
}

function eventFixture(session: Session): DurableSessionEvent {
  return {
    id: `evt_${randomUUID()}`,
    observedAt: session.createdAt,
    payload: {},
    sessionGeneration: session.generation,
    sessionId: session.id,
    type: "session.created",
  };
}

function creationFixture(session: Session) {
  return {
    idempotencyKey: `create_${session.id}`,
    requestHash: "a".repeat(64),
  };
}

function ownerCounts(
  owners: readonly ({ readonly ownerId: string } | undefined)[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const owner of owners) {
    if (owner === undefined) continue;
    counts[owner.ownerId] = (counts[owner.ownerId] ?? 0) + 1;
  }
  return counts;
}
