import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Actor } from "@iterminal/domain";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const actor: Actor = {
  client: "m7-rebuild-rpc",
  id: "agent-m7-rebuild",
  principal: "local-m7-rebuild-agent",
  type: "agent",
};

describeDatabase("M7.2 durable historical Session rebuild", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const fixtures: string[] = [];
  const daemons: RuntimeDaemonHandle[] = [];

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M7 tests refuse to mutate any database except iterminal_test");
    }
    const migrator = new PostgresRuntimeDurability(databaseUrl ?? "");
    await migrator.migrate();
    await migrator.close();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox RESTART IDENTITY CASCADE");
  });

  afterEach(async () => {
    for (const daemon of daemons.splice(0).reverse()) {
      await daemon.close().catch(() => undefined);
    }
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  afterAll(async () => pool.end());

  it("hydrates a same-owner BROKEN projection and explicitly forks a new PTY", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m7-rebuild-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    const restoredCwd = join(workspace, "packages", "runtime");
    await mkdir(restoredCwd, { recursive: true });
    const ownerId = "owner-m7-durable-rebuild";

    const first = await startRuntimeDaemon({
      checkpointEnvironmentKeys: ["ITERM_M7_SAFE"],
      databaseUrl: databaseUrl ?? "",
      ownerId,
      socketPath: join(root, "a.sock"),
    });
    daemons.push(first);
    const firstRpc = new UnixRuntimeClient(first.socketPath);
    const parent = await firstRpc.createSession({ shell: "zsh", workspaceRoot: workspace });
    const mutation = await firstRpc.startExecute({
      actor,
      command: "cd packages/runtime && export ITERM_M7_SAFE=historical",
      idempotencyKey: "m7-rebuild-parent-state",
      sessionGeneration: parent.generation,
      sessionId: parent.id,
    });
    await firstRpc.waitExecution(mutation.execution.id);
    const sourceCheckpoint = await firstRpc.getSessionCheckpoint(parent.id, parent.generation);
    expect(sourceCheckpoint).toMatchObject({ stale: false, version: 2 });

    // Model an owner process disappearing without its graceful durable close path.
    first.runtime.shutdownLiveOwner("injected owner process loss");
    await first.close();
    daemons.splice(daemons.indexOf(first), 1);

    const replacement = await startRuntimeDaemon({
      checkpointEnvironmentKeys: ["ITERM_M7_SAFE"],
      databaseUrl: databaseUrl ?? "",
      ownerId,
      socketPath: join(root, "b.sock"),
    });
    daemons.push(replacement);
    await replacement.waitUntilReady();
    const rpc = new UnixRuntimeClient(replacement.socketPath);

    const historical = (await rpc.listSessions()).find((session) => session.id === parent.id);
    expect(historical).toMatchObject({
      generation: parent.generation,
      id: parent.id,
      status: "BROKEN",
    });
    expect(historical?.activeExecutionId).toBeUndefined();
    await expect(rpc.getScreen(parent.id, parent.generation)).rejects.toMatchObject({
      code: "SESSION_BROKEN",
    });
    const stale = await rpc.getSessionCheckpoint(parent.id, parent.generation);
    expect(stale).toMatchObject({
      contentHash: sourceCheckpoint.contentHash,
      cwd: restoredCwd,
      environmentKeys: ["ITERM_M7_SAFE"],
      sourceStatus: "BROKEN",
      stale: true,
      version: sourceCheckpoint.version,
    });

    const fork = await rpc.forkSession({
      actor,
      allowStale: true,
      expectedCheckpointVersion: stale.version,
      idempotencyKey: "m7-rebuild-explicit-fork",
      sessionGeneration: parent.generation,
      sessionId: parent.id,
    });
    expect(fork).toMatchObject({
      replayed: false,
      session: {
        lineage: {
          checkpointVersion: stale.version,
          parentGeneration: parent.generation,
          parentSessionId: parent.id,
        },
        status: "READY",
      },
    });
    expect(fork.session.id).not.toBe(parent.id);

    const childMutation = await rpc.startExecute({
      actor,
      command: 'printf \'PWD=%s SAFE=%s\\n\' "$PWD" "$ITERM_M7_SAFE"',
      idempotencyKey: "m7-rebuild-child-state",
      sessionGeneration: fork.session.generation,
      sessionId: fork.session.id,
    });
    const completed = await rpc.waitExecution(childMutation.execution.id);
    expect(completed.output).toContain(`PWD=${restoredCwd}`);
    expect(completed.output).toContain("SAFE=historical");

    const durable = await pool.query<{
      actor_id: string;
      child_session_id: string;
      parent_status: string;
    }>(
      `SELECT f.actor_id, f.child_session_id, parent.status AS parent_status
         FROM session_forks f
         JOIN sessions parent ON parent.id = f.parent_session_id
        WHERE f.parent_session_id = $1 AND f.parent_generation = $2`,
      [parent.id, parent.generation],
    );
    expect(durable.rows).toEqual([
      {
        actor_id: actor.id,
        child_session_id: fork.session.id,
        parent_status: "BROKEN",
      },
    ]);
    await rpc.closeSession(fork.session.id, fork.session.generation);
  }, 45_000);
});
