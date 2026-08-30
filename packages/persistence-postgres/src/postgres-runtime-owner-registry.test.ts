import { PostgresRuntimeOwnerRegistry } from "./postgres-runtime-owner-registry.js";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

  function createRegistry(): PostgresRuntimeOwnerRegistry {
    const registry = new PostgresRuntimeOwnerRegistry(databaseUrl ?? "");
    registries.push(registry);
    return registry;
  }
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
