import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgresRuntimeDurability,
  PostgresRuntimeOwnerRegistry,
} from "@iterminal/persistence-postgres";
import { RuntimeError } from "@iterminal/domain";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "@iterminal/runtime-daemon";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startRuntimeRouter, type RuntimeRouterHandle } from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("M9.2 central Runtime Router", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const daemons: RuntimeDaemonHandle[] = [];
  const fixtures: string[] = [];
  const registries: PostgresRuntimeOwnerRegistry[] = [];
  const routers: RuntimeRouterHandle[] = [];

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M9 Router tests refuse to mutate any database except iterminal_test");
    }
    const migrator = new PostgresRuntimeDurability(databaseUrl ?? "");
    await migrator.migrate();
    await migrator.close();
    const index = await pool.query<{ name: string | null }>(
      "SELECT to_regclass('sessions_live_owner_idx')::text AS name",
    );
    expect(index.rows[0]?.name).toBe("sessions_live_owner_idx");
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox, runtime_workers RESTART IDENTITY CASCADE");
  });

  afterEach(async () => {
    for (const router of routers.splice(0).reverse()) await router.close().catch(() => undefined);
    for (const daemon of daemons.splice(0).reverse()) await daemon.close().catch(() => undefined);
    for (const registry of registries.splice(0).reverse()) {
      await registry.close().catch(() => undefined);
    }
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  afterAll(async () => pool.end());

  it("pages durable candidates before routing and preserves healthy Sessions during an owner outage", async () => {
    const root = await fixture("partial-discovery");
    const left = await daemon(root, "owner-discovery-a", "instance-discovery-a", "left.sock");
    const right = await daemon(root, "owner-discovery-b", "instance-discovery-b", "right.sock");
    const first = await new UnixRuntimeClient(left.socketPath).createSession({
      shell: "zsh",
      workspaceRoot: root,
    });
    const second = await new UnixRuntimeClient(right.socketPath).createSession({
      shell: "zsh",
      workspaceRoot: root,
    });
    const router = await runtimeRouter(root);
    const client = new UnixRuntimeClient(router.socketPath);
    const initial = await client.listSessionsV2({ limit: 1 });
    expect(initial.items).toHaveLength(1);
    expect(initial.nextCursor).not.toBeNull();
    const next = await client.listSessionsV2({ cursor: initial.nextCursor!, limit: 1 });
    expect(new Set([...initial.items, ...next.items].map((item) => item.session.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(next.nextCursor).toBeNull();
    await pool.query("UPDATE runtime_workers SET endpoint = $1 WHERE owner_id = $2", [
      join(root, "missing.sock"),
      first.ownerId,
    ]);
    const partial = await client.listSessionsV2();
    expect(partial).toMatchObject({ partial: true, unavailableOwners: [first.ownerId] });
    expect(partial.items.find((item) => item.session.id === first.id)).toMatchObject({
      durableStatus: "READY",
      liveAvailability: "unavailable",
    });
    expect(partial.items.find((item) => item.session.id === second.id)).toMatchObject({
      liveAvailability: "available",
    });
    await expect(
      client.startExecute({
        actor,
        command: "true",
        idempotencyKey: "discovery-offline-write",
        sessionGeneration: first.generation,
        sessionId: first.id,
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
    const pending = await client.requestExecuteApproval({
      actor,
      command: "true",
      actionIdempotencyKey: "inbox-action",
      requestIdempotencyKey: "inbox-request",
      sessionGeneration: second.generation,
      sessionId: second.id,
      reason: "global inbox",
    });
    const inbox = await client.listPendingApprovals({ actor: human });
    expect(inbox).toMatchObject({
      partial: true,
      unavailableOwners: [first.ownerId],
      items: [expect.objectContaining({ id: pending.id, sessionId: second.id })],
    });
    await expect(client.listPendingApprovals({ actor })).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
  }, 30_000);

  it("places new Sessions and routes exact operations across two live owners", async () => {
    const root = await fixture("multi-owner");
    const leftWorkspace = join(root, "left");
    const rightWorkspace = join(root, "right");
    await Promise.all([
      mkdir(join(leftWorkspace, "nested"), { recursive: true }),
      mkdir(rightWorkspace, { recursive: true }),
    ]);
    const left = await daemon(root, "owner-router-a", "instance-router-a", "left.sock");
    const right = await daemon(root, "owner-router-b", "instance-router-b", "right.sock");
    const router = await runtimeRouter(root);
    const client = new UnixRuntimeClient(router.socketPath);

    const first = await client.createSession({ shell: "zsh", workspaceRoot: leftWorkspace });
    expect(first.ownerId).toBe("owner-router-a");
    const second = await client.createSession({ shell: "zsh", workspaceRoot: rightWorkspace });
    expect(second.ownerId).toBe("owner-router-b");

    const approval = await client.requestExecuteApproval({
      actionIdempotencyKey: "router-approved-action",
      actor,
      command: "export ROUTER_APPROVED=yes",
      reason: "Verify exact owner Approval routing",
      requestIdempotencyKey: "router-approval-request",
      sessionGeneration: first.generation,
      sessionId: first.id,
    });
    expect(
      await client.decideApproval({
        actor: human,
        approvalId: approval.id,
        decision: "approve",
        expectedVersion: approval.version,
        idempotencyKey: "router-approval-decision",
        reason: "Exact routed proposal reviewed",
        sessionGeneration: first.generation,
        sessionId: first.id,
      }),
    ).toMatchObject({ status: "APPROVED", version: 2 });
    const approved = await client.startExecute({
      actor,
      approvalId: approval.id,
      command: "export ROUTER_APPROVED=yes",
      idempotencyKey: "router-approved-action",
      sessionGeneration: first.generation,
      sessionId: first.id,
    });
    expect((await client.waitExecution(approved.execution.id)).status).toBe("COMPLETED");
    expect(
      await client.getApproval({
        actor,
        approvalId: approval.id,
        sessionGeneration: first.generation,
        sessionId: first.id,
      }),
    ).toMatchObject({ status: "CONSUMED", version: 3 });

    const firstResult = join(root, "first.txt");
    const firstSetup = await client.startExecute({
      actor,
      command: `cd nested && export ROUTER_VALUE=left`,
      idempotencyKey: "router-left-setup",
      sessionGeneration: first.generation,
      sessionId: first.id,
    });
    expect((await client.waitExecution(firstSetup.execution.id)).status).toBe("COMPLETED");
    const firstWrite = await client.startExecute({
      actor,
      command: `printf '%s|%s' "$PWD" "$ROUTER_VALUE" > ${shellQuote(firstResult)}`,
      idempotencyKey: "router-left-write",
      sessionGeneration: first.generation,
      sessionId: first.id,
    });
    expect((await client.waitExecution(firstWrite.execution.id)).status).toBe("COMPLETED");
    expect(await readFile(firstResult, "utf8")).toBe(`${join(leftWorkspace, "nested")}|left`);

    const secondResult = join(root, "second.txt");
    const secondWrite = await client.startExecute({
      actor,
      command: `printf '%s' "$PWD" > ${shellQuote(secondResult)}`,
      idempotencyKey: "router-right-write",
      sessionGeneration: second.generation,
      sessionId: second.id,
    });
    expect((await client.getExecution(secondWrite.execution.id)).sessionId).toBe(second.id);
    expect((await client.waitExecution(secondWrite.execution.id)).status).toBe("COMPLETED");
    expect(await readFile(secondResult, "utf8")).toBe(rightWorkspace);

    const screenBefore = await client.getScreen(first.id, first.generation);
    const marker = await client.startExecute({
      actor,
      command: "printf 'router-screen-marker\\n'",
      idempotencyKey: "router-screen-marker",
      sessionGeneration: first.generation,
      sessionId: first.id,
    });
    expect((await client.waitExecution(marker.execution.id)).status).toBe("COMPLETED");
    expect(
      (
        await client.waitForScreen({
          condition: { caseSensitive: true, text: "router-screen-marker", type: "text" },
          generation: first.generation,
          sessionId: first.id,
          timeoutMilliseconds: 2_000,
        })
      ).matched,
    ).toBe(true);
    expect(
      (
        await client.searchScreen({
          caseSensitive: true,
          generation: first.generation,
          maxMatches: 5,
          query: "router-screen-marker",
          sessionId: first.id,
        })
      ).matches.length,
    ).toBeGreaterThan(0);
    expect(
      await client.getScreenRegion({
        columnCount: 20,
        generation: first.generation,
        rowCount: 2,
        sessionId: first.id,
        startColumn: 0,
        startRow: 0,
      }),
    ).toMatchObject({ columnCount: 20, rowCount: 2 });
    expect(
      await client.getScreenCells({
        columnCount: 20,
        generation: first.generation,
        rowCount: 2,
        sessionId: first.id,
        startColumn: 0,
        startRow: 0,
      }),
    ).toMatchObject({ columnCount: 20, rowCount: 2 });
    expect(
      await client.getScreenDiff({
        afterVersion: screenBefore.screenVersion,
        generation: first.generation,
        sessionId: first.id,
      }),
    ).toBeDefined();
    expect((await client.getTerminalState(first.id, first.generation)).frame.sessionId).toBe(
      first.id,
    );
    expect((await client.getInteractionState(first.id, first.generation)).version).toBe(1);
    expect(
      (await client.queryEvents(first.id, first.generation, 0, 500)).events.length,
    ).toBeGreaterThan(0);

    const resized = await client.resizeTerminal({
      actor,
      columns: 100,
      expectedGeometryVersion: screenBefore.geometryVersion,
      idempotencyKey: "router-resize",
      rows: 30,
      sessionGeneration: first.generation,
      sessionId: first.id,
    });
    expect(resized).toMatchObject({ columns: 100, rows: 30, status: "DELIVERED" });

    const inputResult = join(root, "input.txt");
    const interactive = await client.startExecute({
      actor,
      command: `read -r routed_input; printf '%s' "$routed_input" > ${shellQuote(inputResult)}`,
      idempotencyKey: "router-input-command",
      sessionGeneration: first.generation,
      sessionId: first.id,
    });
    await waitForExecutionStatus(client, interactive.execution.id, "RUNNING");
    const input = await client.sendInput({
      actor,
      data: "input-via-router\n",
      idempotencyKey: "router-targeted-input",
      sessionGeneration: first.generation,
      sessionId: first.id,
      targetExecutionId: interactive.execution.id,
    });
    expect(input.status).toBe("DELIVERED");
    expect((await client.waitExecution(interactive.execution.id)).status).toBe("COMPLETED");
    expect(await readFile(inputResult, "utf8")).toBe("input-via-router");

    const controlled = await client.startExecute({
      actor,
      command: "sleep 30",
      idempotencyKey: "router-control-command",
      sessionGeneration: first.generation,
      sessionId: first.id,
    });
    await waitForExecutionStatus(client, controlled.execution.id, "RUNNING");
    const control = await client.sendControl({
      actor,
      delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
      idempotencyKey: "router-targeted-control",
      sessionGeneration: first.generation,
      sessionId: first.id,
      targetExecutionId: controlled.execution.id,
    });
    expect(control.status).toBe("DELIVERED");
    expect((await client.waitExecution(controlled.execution.id)).status).toBe("INTERRUPTED");

    const checkpoint = await client.getSessionCheckpoint(first.id, first.generation);
    const forked = await client.forkSession({
      actor,
      allowStale: false,
      expectedCheckpointVersion: checkpoint.version,
      idempotencyKey: "router-session-fork",
      sessionGeneration: first.generation,
      sessionId: first.id,
    });
    expect(forked.session.ownerId).toBe(first.ownerId);
    await client.closeSession(forked.session.id, forked.session.generation);

    expect((await client.listSessions()).map((session) => session.id).sort()).toEqual(
      [first.id, second.id, forked.session.id].sort(),
    );

    const registry = observer();
    const leftRegistration = left.ownerRegistration();
    if (leftRegistration === undefined) throw new Error("Left owner registration is missing");
    await registry.beginOwnerDrain(leftRegistration, 5_000);
    expect(await registry.listAssignableOwners()).toEqual([
      expect.objectContaining({ ownerId: "owner-router-b", status: "ACTIVE" }),
    ]);

    const afterDrain = join(root, "after-drain.txt");
    const existingWrite = await client.startExecute({
      actor,
      command: `printf routed > ${shellQuote(afterDrain)}`,
      idempotencyKey: "router-existing-draining-owner",
      sessionGeneration: first.generation,
      sessionId: first.id,
    });
    expect((await client.waitExecution(existingWrite.execution.id)).status).toBe("COMPLETED");
    expect(await readFile(afterDrain, "utf8")).toBe("routed");

    const third = await client.createSession({ shell: "zsh", workspaceRoot: rightWorkspace });
    expect(third.ownerId).toBe("owner-router-b");

    const rightRegistration = right.ownerRegistration();
    if (rightRegistration === undefined) throw new Error("Right owner registration is missing");
    await registry.stopOwner(rightRegistration);
    await expect(client.getSession(second.id)).rejects.toMatchObject({
      code: "OWNER_ROUTE_UNAVAILABLE",
      details: { ownerId: "owner-router-b", targetKind: "session" },
      retryable: true,
    });
    await expect(
      client.startExecute({
        actor,
        command: "printf must-not-run",
        idempotencyKey: "router-stopped-owner",
        sessionGeneration: second.generation,
        sessionId: second.id,
      }),
    ).rejects.toMatchObject({ code: "OWNER_ROUTE_UNAVAILABLE" });
    await expect(
      client.createSession({ shell: "zsh", workspaceRoot: rightWorkspace }),
    ).rejects.toMatchObject({ code: "OWNER_ROUTE_UNAVAILABLE" });
    expect((await client.getSession(first.id)).ownerId).toBe("owner-router-a");
    await expect(client.getSession("missing-session")).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
    await expect(client.getExecution("missing-execution")).rejects.toMatchObject({
      code: "EXECUTION_NOT_FOUND",
    });
  }, 45_000);

  it("atomically balances concurrent Session placement across three owners and excludes drain", async () => {
    const root = await fixture("fair-placement");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const owners = await Promise.all([
      daemon(root, "owner-fair-a", "instance-fair-a", "fair-a.sock"),
      daemon(root, "owner-fair-b", "instance-fair-b", "fair-b.sock"),
      daemon(root, "owner-fair-c", "instance-fair-c", "fair-c.sock"),
    ]);
    const router = await runtimeRouter(root);
    const client = new UnixRuntimeClient(router.socketPath);

    const firstWave = await Promise.all(
      Array.from({ length: 12 }, () =>
        client.createSession({ shell: "zsh", workspaceRoot: workspace }),
      ),
    );
    expect(sessionOwnerCounts(firstWave)).toEqual({
      "owner-fair-a": 4,
      "owner-fair-b": 4,
      "owner-fair-c": 4,
    });
    const duplicateLeases = await pool.query(
      `SELECT session.id
         FROM sessions AS session
         LEFT JOIN session_leases AS lease
           ON lease.session_id = session.id
          AND lease.session_generation = session.current_generation
          AND lease.released_at IS NULL
        WHERE session.id = ANY($1::text[])
        GROUP BY session.id
       HAVING count(lease.session_id) <> 1`,
      [firstWave.map((session) => session.id)],
    );
    expect(duplicateLeases.rowCount).toBe(0);

    const middle = owners[1]?.ownerRegistration();
    if (middle === undefined) throw new Error("Middle fair-placement owner is missing");
    await observer().beginOwnerDrain(middle, 5_000);
    const secondWave = await Promise.all(
      Array.from({ length: 6 }, () =>
        client.createSession({ shell: "zsh", workspaceRoot: workspace }),
      ),
    );
    expect(sessionOwnerCounts(secondWave)).toEqual({
      "owner-fair-a": 3,
      "owner-fair-c": 3,
    });
    const placement = await pool.query<{ owner_id: string; placement_count: string }>(
      `SELECT owner_id, placement_count::text
         FROM runtime_workers
        WHERE owner_id LIKE 'owner-fair-%'
        ORDER BY owner_id`,
    );
    expect(placement.rows).toEqual([
      { owner_id: "owner-fair-a", placement_count: "7" },
      { owner_id: "owner-fair-b", placement_count: "4" },
      { owner_id: "owner-fair-c", placement_count: "7" },
    ]);

    await Promise.all(
      [...firstWave, ...secondWave].map((session) =>
        client.closeSession(session.id, session.generation),
      ),
    );
  }, 60_000);

  it("rate-limits one Actor across owners and all Actors within one Session", async () => {
    const root = await fixture("rate-limit");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const limits = {
      actionRateLimitWindowMilliseconds: 5_000,
      actorActionRateLimit: 2,
      sessionActionRateLimit: 2,
    } as const;
    await Promise.all([
      daemon(root, "owner-rate-a", "instance-rate-a", "rate-a.sock", limits),
      daemon(root, "owner-rate-b", "instance-rate-b", "rate-b.sock", limits),
    ]);
    const router = await runtimeRouter(root);
    const client = new UnixRuntimeClient(router.socketPath);
    const sessions = await Promise.all(
      Array.from({ length: 4 }, () =>
        client.createSession({ shell: "zsh", workspaceRoot: workspace }),
      ),
    );
    expect(sessionOwnerCounts(sessions)).toEqual({ "owner-rate-a": 2, "owner-rate-b": 2 });
    const firstOwnerSessions = sessions.filter((session) => session.ownerId === "owner-rate-a");
    const secondOwnerSessions = sessions.filter((session) => session.ownerId === "owner-rate-b");
    const firstSession = requiredSession(firstOwnerSessions, 0);
    const secondSession = requiredSession(secondOwnerSessions, 0);
    const thirdSession = requiredSession(firstOwnerSessions, 1);
    const limitedSession = requiredSession(secondOwnerSessions, 1);

    const sharedActor = actorFixture("shared-rate-actor");
    const firstRequest = {
      actor: sharedActor,
      command: "true",
      idempotencyKey: "rate-shared-first",
      sessionGeneration: firstSession.generation,
      sessionId: firstSession.id,
    } as const;
    const first = await client.startExecute(firstRequest);
    await client.waitExecution(first.execution.id);
    const replay = await client.startExecute(firstRequest);
    expect(replay.action.id).toBe(first.action.id);
    const second = await client.startExecute({
      actor: sharedActor,
      command: "true",
      idempotencyKey: "rate-shared-second",
      sessionGeneration: secondSession.generation,
      sessionId: secondSession.id,
    });
    await client.waitExecution(second.execution.id);
    const actorRejection = await captureRateLimited(
      client.startExecute({
        actor: sharedActor,
        command: "true",
        idempotencyKey: "rate-shared-rejected",
        sessionGeneration: thirdSession.generation,
        sessionId: thirdSession.id,
      }),
    );
    expect(actorRejection).toMatchObject({
      code: "RATE_LIMITED",
      details: {
        limit: 2,
        subjectId: sharedActor.id,
        subjectKind: "actor",
        windowMilliseconds: 5_000,
      },
      retryable: true,
    });

    for (const suffix of ["a", "b"] as const) {
      const started = await client.startExecute({
        actor: actorFixture(`session-rate-${suffix}`),
        command: "true",
        idempotencyKey: `session-rate-${suffix}`,
        sessionGeneration: limitedSession.generation,
        sessionId: limitedSession.id,
      });
      await client.waitExecution(started.execution.id);
    }
    const sessionRejection = await captureRateLimited(
      client.startExecute({
        actor: actorFixture("session-rate-c"),
        command: "true",
        idempotencyKey: "session-rate-c",
        sessionGeneration: limitedSession.generation,
        sessionId: limitedSession.id,
      }),
    );
    expect(sessionRejection).toMatchObject({
      code: "RATE_LIMITED",
      details: {
        limit: 2,
        subjectId: limitedSession.id,
        subjectKind: "session",
        windowMilliseconds: 5_000,
      },
      retryable: true,
    });

    const durable = await pool.query<{
      action_count: string;
      actor_id: string;
    }>(
      `SELECT actor_id, action_count::text
         FROM actor_action_rate_limit_buckets
        WHERE actor_id = $1`,
      [sharedActor.id],
    );
    expect(durable.rows).toEqual([{ action_count: "2", actor_id: sharedActor.id }]);
    const rejected = await pool.query<{ actions: string; status: string }>(
      `SELECT session.status, count(action.id)::text AS actions
         FROM sessions session
         LEFT JOIN actions action ON action.session_id = session.id
        WHERE session.id = $1
        GROUP BY session.status`,
      [thirdSession.id],
    );
    expect(rejected.rows[0]).toEqual({ actions: "0", status: "READY" });
  }, 45_000);

  it("fails closed for a live registry route whose Unix endpoint is absent", async () => {
    const root = await fixture("missing-endpoint");
    const registry = observer();
    const registration = await registry.registerOwner({
      endpoint: join(root, "missing.sock"),
      instanceId: "instance-router-missing",
      leaseMilliseconds: 5_000,
      ownerId: "owner-router-missing",
    });
    await pool.query(
      `INSERT INTO sessions
        (id, current_generation, status, shell, workspace_root, owner_id,
         next_action_sequence, screen_version, created_at)
       VALUES ('session-router-missing', 1, 'READY', 'zsh', $1, $2, 0, 0, now())`,
      [root, registration.ownerId],
    );
    await pool.query(
      `INSERT INTO session_generations
        (session_id, generation, owner_id, integration_version, status, started_at)
       VALUES ('session-router-missing', 1, $1, 'runtime-v1', 'READY', now())`,
      [registration.ownerId],
    );
    const router = await runtimeRouter(root);
    const client = new UnixRuntimeClient(router.socketPath);

    await expect(client.getSession("session-router-missing")).rejects.toMatchObject({
      code: "OWNER_ROUTE_UNAVAILABLE",
      details: {
        ownerEpoch: 1,
        ownerId: registration.ownerId,
        ownerInstanceId: registration.instanceId,
      },
    });
    await expect(client.listSessions()).rejects.toMatchObject({
      code: "OWNER_ROUTE_UNAVAILABLE",
    });
    await expect(client.closeSession("session-router-missing", 1)).rejects.toMatchObject({
      code: "DELIVERY_UNKNOWN",
      details: { ownerId: registration.ownerId },
    });
    await expect(access(join(root, "missing.sock"))).rejects.toThrow();
  }, 30_000);

  async function fixture(suffix: string): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), `itr-m92-${suffix.slice(0, 4)}-`)));
    fixtures.push(root);
    return root;
  }

  async function daemon(
    root: string,
    ownerId: string,
    ownerInstanceId: string,
    socketName: string,
    limits:
      | Readonly<{
          actionRateLimitWindowMilliseconds: number;
          actorActionRateLimit: number;
          sessionActionRateLimit: number;
        }>
      | undefined = undefined,
  ): Promise<RuntimeDaemonHandle> {
    const handle = await startRuntimeDaemon({
      databaseHealthCheckMilliseconds: 50,
      databaseUrl: databaseUrl ?? "",
      ownerId,
      ownerInstanceId,
      ownerLeaseMilliseconds: 5_000,
      sessionLeaseMilliseconds: 5_000,
      socketPath: join(root, socketName),
      ...(limits ?? {}),
    });
    daemons.push(handle);
    return handle;
  }

  async function runtimeRouter(root: string): Promise<RuntimeRouterHandle> {
    const router = await startRuntimeRouter({
      databaseUrl: databaseUrl ?? "",
      socketPath: join(root, "router.sock"),
    });
    routers.push(router);
    return router;
  }

  function observer(): PostgresRuntimeOwnerRegistry {
    const registry = new PostgresRuntimeOwnerRegistry(databaseUrl ?? "");
    registries.push(registry);
    return registry;
  }
});

const actor = {
  client: "m9-router-test",
  id: "agent-m9-router",
  principal: "local-agent",
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  type: "agent" as const,
};

const human = {
  client: "m10-router-human",
  id: "human-m10-router",
  principal: "local-human",
  capabilities: ACTOR_CAPABILITY_PROFILES.human,
  type: "human" as const,
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sessionOwnerCounts(
  sessions: readonly { readonly ownerId: string }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const session of sessions) {
    counts[session.ownerId] = (counts[session.ownerId] ?? 0) + 1;
  }
  return counts;
}

function requiredSession<T>(sessions: readonly T[], index: number): T {
  const session = sessions[index];
  if (session === undefined) throw new Error(`Session ${index.toString()} is missing`);
  return session;
}

function actorFixture(id: string) {
  return {
    client: "m9-rate-limit-test",
    id,
    principal: id,
    capabilities: ACTOR_CAPABILITY_PROFILES.agent,
    type: "agent" as const,
  };
}

async function captureRateLimited(promise: Promise<unknown>): Promise<RuntimeError> {
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }
  if (!(rejection instanceof RuntimeError) || rejection.code !== "RATE_LIMITED") {
    if (rejection instanceof Error) throw rejection;
    throw new Error(`Expected RATE_LIMITED rejection, received ${String(rejection)}`);
  }
  const retryAfterMilliseconds = rejection.details.retryAfterMilliseconds;
  if (typeof retryAfterMilliseconds !== "number") {
    throw new Error("RATE_LIMITED must include numeric retryAfterMilliseconds");
  }
  expect(retryAfterMilliseconds).toBeGreaterThan(0);
  return rejection;
}

async function waitForExecutionStatus(
  client: UnixRuntimeClient,
  executionId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await client.getExecution(executionId)).status === status) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`Execution ${executionId} did not reach ${status}`);
}
