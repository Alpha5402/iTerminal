import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeService } from "@iterminal/application";
import { ACTOR_CAPABILITY_PROFILES, type Actor } from "@iterminal/domain";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { MemoryRuntimeStore } from "@iterminal/runtime-memory";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("A06 durable Action lookup", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let daemon: RuntimeDaemonHandle | undefined;
  let lookupDurability: PostgresRuntimeDurability | undefined;
  let fixtureRoot = "";

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("A06 tests refuse to mutate any database except iterminal_test");
    }
    const migrator = new PostgresRuntimeDurability(databaseUrl ?? "");
    await migrator.migrate();
    await migrator.close();
  });

  beforeEach(async () => {
    await daemon?.close().catch(() => undefined);
    daemon = undefined;
    await lookupDurability?.close().catch(() => undefined);
    lookupDurability = undefined;
    if (fixtureRoot !== "") await rm(fixtureRoot, { force: true, recursive: true });
    fixtureRoot = "";
    await pool.query("TRUNCATE sessions, actors, outbox RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    await daemon?.close().catch(() => undefined);
    await lookupDurability?.close().catch(() => undefined);
    if (fixtureRoot !== "") await rm(fixtureRoot, { force: true, recursive: true });
    await pool.end();
  });

  it("recovers an accepted real PTY fact from PostgreSQL without replaying the command", async () => {
    fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "iterminal-a06-durable-")));
    const workspace = join(fixtureRoot, "workspace");
    await mkdir(workspace);
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-a06-durable",
      socketPath: join(fixtureRoot, "runtime.sock"),
    });
    const client = new UnixRuntimeClient(daemon.socketPath);
    const actor: Actor = {
      capabilities: ACTOR_CAPABILITY_PROFILES.agent,
      client: "a06-durable-rpc",
      id: "agent-a06-durable",
      principal: "a06-durable-principal",
      type: "agent",
    };
    const session = await client.createSession({
      idempotencyKey: "a06-durable-session",
      shell: "zsh",
      workspaceRoot: workspace,
    });
    const started = await client.startExecute({
      actor,
      command: "printf a06-durable",
      idempotencyKey: "a06-durable-execute",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    const completed = await client.waitExecution(started.execution.id);
    expect(completed.status).toBe("COMPLETED");

    lookupDurability = new PostgresRuntimeDurability(databaseUrl ?? "");
    const freshRuntime = new RuntimeService(
      new MemoryRuntimeStore(),
      { create: () => Promise.reject(new Error("lookup must not create an Executor")) },
      { durability: lookupDurability },
    );
    const found = await freshRuntime.lookupAction({
      actor,
      generation: session.generation,
      idempotencyKey: "a06-durable-execute",
      sessionId: session.id,
    });
    expect(found).toMatchObject({
      actionId: started.action.id,
      actionStatus: "COMPLETED",
      actionType: "execute",
      executionId: started.execution.id,
      executionStatus: "COMPLETED",
      kind: "found",
    });
    expect(found).not.toHaveProperty("requestHash");
    expect(JSON.stringify(found)).not.toContain("printf a06-durable");

    await expect(
      freshRuntime.lookupAction({
        actor: { ...actor, principal: "forged-principal" },
        generation: session.generation,
        idempotencyKey: "a06-durable-execute",
        sessionId: session.id,
      }),
    ).resolves.toMatchObject({ kind: "not_found", mayStillBeInFlight: true });

    const closedDurability = lookupDurability;
    await closedDurability.close();
    lookupDurability = undefined;
    const unavailableRuntime = new RuntimeService(
      new MemoryRuntimeStore(),
      { create: () => Promise.reject(new Error("lookup must not create an Executor")) },
      { durability: closedDurability },
    );
    await expect(
      unavailableRuntime.lookupAction({
        actor,
        generation: session.generation,
        idempotencyKey: "a06-durable-execute",
        sessionId: session.id,
      }),
    ).resolves.toMatchObject({
      kind: "unavailable",
      reason: "durability_unavailable",
      retryable: true,
    });
    await client.closeSession(session.id, session.generation);
  }, 30_000);
});
