import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgresRuntimeDurability,
  PostgresRuntimeOwnerRegistry,
} from "@iterminal/persistence-postgres";
import type { SessionFence } from "@iterminal/application";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("M9.1 Runtime daemon owner registry lifecycle", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const fixtures: string[] = [];
  const daemons: RuntimeDaemonHandle[] = [];
  let observer: PostgresRuntimeOwnerRegistry | undefined;

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M9 tests refuse to mutate any database except iterminal_test");
    }
    const migrator = new PostgresRuntimeDurability(databaseUrl ?? "");
    await migrator.migrate();
    await migrator.close();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox, runtime_workers RESTART IDENTITY CASCADE");
    observer = new PostgresRuntimeOwnerRegistry(databaseUrl ?? "");
  });

  afterEach(async () => {
    for (const daemon of daemons.splice(0).reverse()) {
      await daemon.close().catch(() => undefined);
    }
    await observer?.close().catch(() => undefined);
    observer = undefined;
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  afterAll(async () => pool.end());

  it("rejects a concurrent incarnation before recovery, heartbeats, drains, and advances epoch", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m9-owner-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const ownerId = "owner-m9-lifecycle";

    const first = await startRuntimeDaemon({
      databaseHealthCheckMilliseconds: 50,
      databaseUrl: databaseUrl ?? "",
      ownerId,
      ownerInstanceId: "owner-m9-instance-a",
      ownerLeaseMilliseconds: 500,
      socketPath: join(root, "a.sock"),
    });
    daemons.push(first);
    expect(first.ownerRegistration()).toMatchObject({
      endpoint: join(root, "a.sock"),
      epoch: 1,
      instanceId: "owner-m9-instance-a",
      status: "ACTIVE",
    });
    const firstRpc = new UnixRuntimeClient(first.socketPath);
    const session = await firstRpc.createSession({ shell: "zsh", workspaceRoot: workspace });
    await delay(130);
    expect(await requiredObserver().resolveLiveOwner(ownerId)).toMatchObject({
      activeSessionCount: 1,
      epoch: 1,
      status: "ACTIVE",
    });
    expect((await requiredObserver().resolveLiveOwner(ownerId))?.version).toBeGreaterThan(1);
    const renewedLease = await pool.query<{
      lease_expires_at: Date;
      version: string;
    }>(
      `SELECT lease_expires_at, version::text FROM session_leases
        WHERE session_id = $1 AND session_generation = $2`,
      [session.id, session.generation],
    );
    expect(Number.parseInt(renewedLease.rows[0]?.version ?? "0", 10)).toBeGreaterThan(1);
    expect(renewedLease.rows[0]?.lease_expires_at.getTime()).toBeGreaterThan(Date.now());

    const conflicting = await startRuntimeDaemon({
      databaseHealthCheckMilliseconds: 50,
      databaseReconnectInitialMilliseconds: 20,
      databaseReconnectJitterRatio: 0,
      databaseReconnectMaxMilliseconds: 20,
      databaseUrl: databaseUrl ?? "",
      ownerId,
      ownerInstanceId: "owner-m9-instance-conflict",
      ownerLeaseMilliseconds: 500,
      socketPath: join(root, "b.sock"),
    });
    daemons.push(conflicting);
    expect(conflicting.durabilityState().phase).not.toBe("READY");
    expect(conflicting.ownerRegistration()).toBeUndefined();
    await expect(
      new UnixRuntimeClient(conflicting.socketPath).listSessions(),
    ).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
    expect(first.durabilityState()).toMatchObject({ phase: "READY" });
    expect((await firstRpc.getSession(session.id)).status).toBe("READY");

    await conflicting.close();
    daemons.splice(daemons.indexOf(conflicting), 1);
    expect(await requiredObserver().resolveLiveOwner(ownerId)).toMatchObject({
      instanceId: "owner-m9-instance-a",
    });

    await first.close();
    daemons.splice(daemons.indexOf(first), 1);
    expect(await requiredObserver().resolveLiveOwner(ownerId)).toBeUndefined();
    const stopped = await pool.query<{
      registry_epoch: string;
      status: string;
      stopped_at: Date | null;
    }>("SELECT registry_epoch::text, status, stopped_at FROM runtime_workers WHERE owner_id = $1", [
      ownerId,
    ]);
    expect(stopped.rows[0]).toMatchObject({
      registry_epoch: "1",
      status: "STOPPED",
    });
    expect(stopped.rows[0]?.stopped_at).not.toBeNull();
    const releasedLease = await pool.query<{ release_reason: string; released_at: Date | null }>(
      `SELECT released_at, release_reason FROM session_leases
        WHERE session_id = $1 AND session_generation = $2`,
      [session.id, session.generation],
    );
    expect(releasedLease.rows[0]).toMatchObject({ release_reason: "session closed" });
    expect(releasedLease.rows[0]?.released_at).not.toBeNull();

    const replacement = await startRuntimeDaemon({
      databaseHealthCheckMilliseconds: 50,
      databaseUrl: databaseUrl ?? "",
      ownerId,
      ownerInstanceId: "owner-m9-instance-b",
      ownerLeaseMilliseconds: 500,
      socketPath: join(root, "c.sock"),
    });
    daemons.push(replacement);
    expect(replacement.ownerRegistration()).toMatchObject({
      epoch: 2,
      instanceId: "owner-m9-instance-b",
      status: "ACTIVE",
    });
    expect(await new UnixRuntimeClient(replacement.socketPath).listSessions()).toEqual([]);
  }, 30_000);

  it("breaks every local PTY after its exact registry identity is fenced out", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m9-fenced-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const ownerId = "owner-m9-fenced";
    const daemon = await startRuntimeDaemon({
      databaseHealthCheckMilliseconds: 25,
      databaseReconnectInitialMilliseconds: 20,
      databaseReconnectJitterRatio: 0,
      databaseReconnectMaxMilliseconds: 20,
      databaseUrl: databaseUrl ?? "",
      ownerId,
      ownerInstanceId: "owner-m9-fenced-a",
      ownerLeaseMilliseconds: 250,
      socketPath: join(root, "a.sock"),
    });
    daemons.push(daemon);
    const rpc = new UnixRuntimeClient(daemon.socketPath);
    const session = await rpc.createSession({ shell: "zsh", workspaceRoot: workspace });
    const first = daemon.ownerRegistration();
    if (first === undefined) throw new Error("Daemon owner registration is missing");
    const lease = await pool.query<{
      fencing_token: string;
      owner_instance_id: string;
      owner_registry_epoch: string;
    }>(
      `SELECT fencing_token::text, owner_instance_id, owner_registry_epoch::text
         FROM session_leases WHERE session_id = $1 AND session_generation = $2`,
      [session.id, session.generation],
    );
    const leaseRow = lease.rows[0];
    if (leaseRow === undefined) throw new Error("Session fence was not acquired");
    const staleFence: SessionFence = {
      epoch: Number.parseInt(leaseRow.owner_registry_epoch, 10),
      fencingToken: leaseRow.fencing_token,
      generation: session.generation,
      instanceId: leaseRow.owner_instance_id,
      ownerId,
      sessionId: session.id,
    };

    await requiredObserver().stopOwner(first);
    const replacement = await requiredObserver().registerOwner({
      endpoint: join(root, "replacement.sock"),
      instanceId: "owner-m9-fenced-b",
      leaseMilliseconds: 5_000,
      ownerId,
    });
    expect(replacement.epoch).toBe(2);

    const staleWriter = new PostgresRuntimeDurability(databaseUrl ?? "");
    await expect(
      staleWriter.appendEvent(staleFence, {
        id: `evt_stale_${Date.now().toString()}`,
        observedAt: new Date().toISOString(),
        payload: { mustNotCommit: true },
        sessionGeneration: session.generation,
        sessionId: session.id,
        type: "test.stale_write",
      }),
    ).rejects.toMatchObject({ code: "SESSION_LEASE_LOST", retryable: false });
    const recovery = await staleWriter.recoverOwner(replacement, "replacement fenced old owner");
    expect(recovery).toMatchObject({ brokenSessions: 1 });
    const durable = await pool.query<{
      event_count: string;
      released_at: Date | null;
      status: string;
    }>(
      `SELECT s.status, lease.released_at,
              (SELECT count(*)::text FROM session_events event
                WHERE event.session_id = s.id AND event.event_type = 'test.stale_write')
                AS event_count
         FROM sessions s
         JOIN session_leases lease
           ON lease.session_id = s.id AND lease.session_generation = s.current_generation
        WHERE s.id = $1`,
      [session.id],
    );
    expect(durable.rows[0]).toMatchObject({ event_count: "0", status: "BROKEN" });
    expect(durable.rows[0]?.released_at).not.toBeNull();
    await staleWriter.close();

    await waitUntil(() => daemon.runtime.getSession(session.id).status === "BROKEN");
    expect(daemon.runtime.isDurabilityHealthy()).toBe(false);
    expect(daemon.durabilityState().phase).not.toBe("READY");
    await expect(rpc.listSessions()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(await requiredObserver().resolveLiveOwner(ownerId)).toMatchObject({
      epoch: 2,
      instanceId: "owner-m9-fenced-b",
    });
  }, 30_000);

  it("closes the local PTY and recovers only as a new Session after its Session fence is revoked", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m9-session-fence-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const ownerId = "owner-m9-session-fence";
    const daemon = await startRuntimeDaemon({
      databaseHealthCheckMilliseconds: 25,
      databaseReconnectInitialMilliseconds: 20,
      databaseReconnectJitterRatio: 0,
      databaseReconnectMaxMilliseconds: 20,
      databaseUrl: databaseUrl ?? "",
      ownerId,
      ownerInstanceId: "owner-m9-session-fence-a",
      ownerLeaseMilliseconds: 500,
      sessionLeaseMilliseconds: 250,
      socketPath: join(root, "a.sock"),
    });
    daemons.push(daemon);
    const rpc = new UnixRuntimeClient(daemon.socketPath);
    const session = await rpc.createSession({ shell: "zsh", workspaceRoot: workspace });
    const sleeping = await rpc.startExecute({
      actor: {
        client: "m93-fence-test",
        id: "agent-m93-fence-test",
        principal: "m93-fence-test",
        capabilities: ACTOR_CAPABILITY_PROFILES.agent,
        type: "agent",
      },
      command: "sleep 30",
      idempotencyKey: "m93-revoked-sleep",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await waitUntil(() => daemon.runtime.getExecution(sleeping.execution.id).status === "RUNNING");

    await pool.query(
      `UPDATE session_leases
          SET released_at = now(), release_reason = 'injected revocation',
              lease_expires_at = now(), version = version + 1
        WHERE session_id = $1 AND session_generation = $2`,
      [session.id, session.generation],
    );

    await waitUntil(() => daemon.runtime.getSession(session.id).status === "BROKEN");
    await waitUntil(
      () => daemon.durabilityState().phase === "READY" && daemon.runtime.isDurabilityHealthy(),
    );
    const durable = await pool.query<{ execution_status: string; session_status: string }>(
      `SELECT s.status AS session_status, e.status AS execution_status
         FROM sessions s JOIN executions e ON e.id = s.active_execution_id OR e.session_id = s.id
        WHERE s.id = $1 LIMIT 1`,
      [session.id],
    );
    expect(durable.rows[0]).toMatchObject({
      execution_status: "UNKNOWN",
      session_status: "BROKEN",
    });

    const replacement = await rpc.createSession({ shell: "zsh", workspaceRoot: workspace });
    expect(replacement).toMatchObject({ generation: 1, ownerId, status: "READY" });
    expect(replacement.id).not.toBe(session.id);
    await rpc.closeSession(replacement.id, replacement.generation);
  }, 30_000);

  function requiredObserver(): PostgresRuntimeOwnerRegistry {
    if (observer === undefined) throw new Error("Owner registry observer is unavailable");
    return observer;
  }
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await delay(10);
  }
  throw new Error("Runtime owner state did not converge before timeout");
}
