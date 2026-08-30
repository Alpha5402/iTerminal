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
  client: "m7-durable-rpc",
  id: "agent-m7-durable",
  principal: "local-m7-agent",
  type: "agent",
};

describeDatabase("M7.1 durable checkpoint fork", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const fixtures: string[] = [];
  let daemon: RuntimeDaemonHandle | undefined;

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
    await daemon?.close().catch(() => undefined);
    daemon = undefined;
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  afterAll(async () => pool.end());

  it("commits checkpoint, child lineage, fork idempotency, and attributed Events", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m7-durable-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "packages", "runtime"), { recursive: true });
    daemon = await startRuntimeDaemon({
      checkpointEnvironmentKeys: ["ITERM_M7_SAFE"],
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-m7-durable",
      socketPath: join(root, "runtime.sock"),
    });
    const rpc = new UnixRuntimeClient(daemon.socketPath);
    const parent = await rpc.createSession({ shell: "zsh", workspaceRoot: workspace });
    const mutation = await rpc.startExecute({
      actor,
      command:
        "cd packages/runtime && export ITERM_M7_SAFE=persisted UNLISTED_SECRET=not-persisted",
      idempotencyKey: "m7-durable-state",
      sessionGeneration: parent.generation,
      sessionId: parent.id,
    });
    await rpc.waitExecution(mutation.execution.id);
    const checkpoint = await rpc.getSessionCheckpoint(parent.id, parent.generation);
    expect(checkpoint).toMatchObject({
      environmentKeys: ["ITERM_M7_SAFE"],
      stale: false,
      version: 2,
    });
    await expect(
      rpc.forkSession({
        actor,
        allowStale: false,
        expectedCheckpointVersion: checkpoint.version + 1,
        idempotencyKey: "m7-durable-wrong-version",
        sessionGeneration: parent.generation,
        sessionId: parent.id,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_CHANGED" });

    await pool.query(
      `UPDATE shell_checkpoints
          SET checkpoint_version = checkpoint_version + 1
        WHERE session_id = $1 AND source_generation = $2`,
      [parent.id, parent.generation],
    );
    await expect(
      rpc.forkSession({
        actor,
        allowStale: false,
        expectedCheckpointVersion: checkpoint.version,
        idempotencyKey: "m7-durable-storage-conflict",
        sessionGeneration: parent.generation,
        sessionId: parent.id,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_CHANGED" });
    expect((await rpc.getSessionCheckpoint(parent.id, parent.generation)).version).toBe(
      checkpoint.version,
    );
    const rejectedForks = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM session_forks WHERE parent_session_id = $1",
      [parent.id],
    );
    expect(rejectedForks.rows[0]?.count).toBe("0");
    await pool.query(
      `UPDATE shell_checkpoints
          SET checkpoint_version = $3
        WHERE session_id = $1 AND source_generation = $2`,
      [parent.id, parent.generation, checkpoint.version],
    );

    const request = {
      actor,
      allowStale: false,
      expectedCheckpointVersion: checkpoint.version,
      idempotencyKey: "m7-durable-fork",
      sessionGeneration: parent.generation,
      sessionId: parent.id,
    } as const;
    const fork = await rpc.forkSession(request);
    expect(fork).toMatchObject({ checkpoint: { version: 3 }, replayed: false });
    const replay = await rpc.forkSession(request);
    expect(replay).toMatchObject({ replayed: true, session: { id: fork.session.id } });

    const durable = await pool.query<{
      actor_id: string;
      checkpoint_hash: string;
      checkpoint_version: number;
      child_session_id: string;
      filtered_env: Record<string, string>;
      fork_status: string;
      parent_generation: number;
      parent_session_id: string;
      source_checkpoint_hash: string;
      source_checkpoint_version: number;
    }>(
      `SELECT f.actor_id, f.child_session_id, f.checkpoint_version, f.checkpoint_hash,
              f.status AS fork_status, s.parent_session_id, s.parent_generation,
              s.source_checkpoint_version, s.source_checkpoint_hash, c.filtered_env
         FROM session_forks f
         JOIN sessions s ON s.id = f.child_session_id
         JOIN shell_checkpoints c
           ON c.session_id = f.parent_session_id
          AND c.source_generation = f.parent_generation
        WHERE f.parent_session_id = $1`,
      [parent.id],
    );
    expect(durable.rows).toHaveLength(1);
    expect(durable.rows[0]).toMatchObject({
      actor_id: actor.id,
      checkpoint_hash: fork.checkpoint.contentHash,
      checkpoint_version: 3,
      child_session_id: fork.session.id,
      filtered_env: { ITERM_M7_SAFE: "persisted" },
      fork_status: "READY",
      parent_generation: parent.generation,
      parent_session_id: parent.id,
      source_checkpoint_hash: fork.checkpoint.contentHash,
      source_checkpoint_version: 3,
    });
    expect(JSON.stringify(durable.rows[0]?.filtered_env)).not.toContain("not-persisted");
    const events = await pool.query<{ actor_id: string | null; event_type: string }>(
      `SELECT actor_id, event_type
         FROM session_events
        WHERE session_id = $1 AND event_type LIKE 'session.fork%'
        ORDER BY event_sequence`,
      [parent.id],
    );
    expect(events.rows).toEqual([
      { actor_id: actor.id, event_type: "session.fork_failed" },
      { actor_id: actor.id, event_type: "session.fork_requested" },
      { actor_id: actor.id, event_type: "session.forked" },
    ]);
    const childExecution = await rpc.startExecute({
      actor,
      command: 'printf \'PWD=%s SAFE=%s\\n\' "$PWD" "$ITERM_M7_SAFE"',
      idempotencyKey: "m7-durable-child-state",
      sessionGeneration: fork.session.generation,
      sessionId: fork.session.id,
    });
    const completed = await rpc.waitExecution(childExecution.execution.id);
    expect(completed.output).toContain(`PWD=${join(workspace, "packages", "runtime")}`);
    expect(completed.output).toContain("SAFE=persisted");
    await rpc.closeSession(fork.session.id, fork.session.generation);
    await rpc.closeSession(parent.id, parent.generation);
  }, 45_000);
});
