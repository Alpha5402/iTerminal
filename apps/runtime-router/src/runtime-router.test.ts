import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  PostgresRuntimeDurability,
  PostgresRuntimeOwnerRegistry,
} from "@iterminal/persistence-postgres";
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
    const root = await realpath(
      await mkdtemp(join("/private/tmp", `itr-m92-${suffix.slice(0, 4)}-`)),
    );
    fixtures.push(root);
    return root;
  }

  async function daemon(
    root: string,
    ownerId: string,
    ownerInstanceId: string,
    socketName: string,
  ): Promise<RuntimeDaemonHandle> {
    const handle = await startRuntimeDaemon({
      databaseHealthCheckMilliseconds: 50,
      databaseUrl: databaseUrl ?? "",
      ownerId,
      ownerInstanceId,
      ownerLeaseMilliseconds: 500,
      socketPath: join(root, socketName),
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
  type: "agent" as const,
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
