import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
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
const human: Actor = {
  capabilities: ACTOR_CAPABILITY_PROFILES.human,
  client: "m10-secret-human",
  id: "human-m10-secret",
  principal: "local-m10-secret-human",
  type: "human",
};
const agent: Actor = {
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  client: "m10-secret-agent",
  id: "agent-m10-secret",
  principal: "local-m10-secret-agent",
  type: "agent",
};

describeDatabase("M10.4 durable Human secret input", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const fixtures: string[] = [];
  let daemon: RuntimeDaemonHandle | undefined;

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M10 secret tests refuse to mutate any database except iterminal_test");
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

  it("persists only lifecycle metadata and sends one sanitized stream to every observer", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m10-secret-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-m10-secret",
      socketPath: join(root, "runtime.sock"),
    });
    await daemon.waitUntilReady();
    const rpc = new UnixRuntimeClient(daemon.socketPath);
    const session = await rpc.createSession({
      idempotencyKey: "m10-secret-session",
      shell: "zsh",
      workspaceRoot: workspace,
    });
    const rawSensitiveOutput = "RAW_SENSITIVE_OUTPUT_SENTINEL";
    const started = await rpc.startExecute({
      actor: human,
      command: `IFS= read -r ITERM_SECRET; printf 'ECHO:%s\\n' "$ITERM_SECRET"; python3 -c 'import os; os.write(1, (b"RAW_" + b"SENSITIVE_" + b"OUTPUT_" + b"SENTINEL") * 1000)'; sleep 30`,
      idempotencyKey: "m10-secret-reader",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await waitUntil(async () => (await rpc.getSession(session.id)).status === "RUNNING");
    const secret = "POSTGRES_SECRET_SENTINEL_f410";
    const action = await rpc.beginSecretInput({
      actor: human,
      data: `${secret}\r`,
      idempotencyKey: "m10-secret-submit",
      sessionGeneration: session.generation,
      sessionId: session.id,
      targetExecutionId: started.execution.id,
    });
    expect(action).not.toHaveProperty("data");
    await expect(
      rpc.beginSecretInput({
        actor: human,
        data: "SECOND_SECRET_MUST_NOT_WRITE\r",
        idempotencyKey: "m10-second-secret",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      }),
    ).rejects.toMatchObject({ code: "SENSITIVE_INPUT_ACTIVE" });
    await expect(
      rpc.sendInput({
        actor: agent,
        data: "AGENT_INTERFERENCE_MUST_NOT_WRITE\r",
        idempotencyKey: "m10-agent-input-during-sensitive-period",
        sessionGeneration: session.generation,
        sessionId: session.id,
        targetExecutionId: started.execution.id,
      }),
    ).rejects.toMatchObject({ code: "SENSITIVE_INPUT_ACTIVE" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rpc.sendControl({
      actor: human,
      bypassGuard: true,
      delivery: { control: "CTRL_C", mode: "TTY_CONTROL" },
      idempotencyKey: "m10-human-control-during-sensitive-period",
      sessionGeneration: session.generation,
      sessionId: session.id,
      targetExecutionId: started.execution.id,
    });

    const completed = await rpc.waitExecution(started.execution.id);
    expect(completed.output).toContain("sensitive terminal output redacted");
    expect(completed.output).not.toContain(secret);
    const screen = await rpc.getScreen(session.id, session.generation);
    expect(screen.lines.join("\n")).not.toContain(secret);
    const active = await rpc.getSensitiveInput({
      actor: human,
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    expect(active).toMatchObject({ id: action.sensitiveInputId, status: "ACTIVE", version: 1 });

    const durable = await pool.query<{
      action_payloads: string;
      artifact_content: string;
      event_payloads: string;
      event_search: string;
      sensitive_rows: string;
    }>(
      `SELECT
         coalesce((SELECT string_agg(payload::text, ' ') FROM actions WHERE session_id = $1), '') AS action_payloads,
         coalesce((SELECT string_agg(encode(content, 'escape'), ' ') FROM artifacts WHERE session_id = $1), '') AS artifact_content,
         coalesce((SELECT string_agg(payload::text, ' ') FROM session_events WHERE session_id = $1), '') AS event_payloads,
         coalesce((SELECT string_agg(search_text, ' ') FROM session_events WHERE session_id = $1), '') AS event_search,
         coalesce((SELECT string_agg(row_to_json(sensitive)::text, ' ') FROM sensitive_inputs sensitive WHERE session_id = $1), '') AS sensitive_rows`,
      [session.id],
    );
    expect(JSON.stringify(durable.rows[0])).not.toContain(secret);
    expect(JSON.stringify(durable.rows[0])).not.toContain("SECOND_SECRET_MUST_NOT_WRITE");
    expect(JSON.stringify(durable.rows[0])).not.toContain("AGENT_INTERFERENCE_MUST_NOT_WRITE");
    expect(durable.rows[0]?.artifact_content).not.toContain(rawSensitiveOutput);
    expect(durable.rows[0]?.event_payloads).not.toContain(rawSensitiveOutput);

    const sensitiveArtifactRefs = await pool.query<{
      artifact_refs: string;
      artifact_rows: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE event.payload ? 'artifactRef')::text AS artifact_refs,
         (SELECT count(*)::text FROM artifacts WHERE execution_id = $2) AS artifact_rows
       FROM session_events event
       WHERE event.session_id = $1 AND event.execution_id = $2
         AND event.event_type = 'terminal.pty_output'`,
      [session.id, started.execution.id],
    );
    expect(sensitiveArtifactRefs.rows[0]).toEqual({ artifact_refs: "0", artifact_rows: "0" });
    await expect(
      rpc.readArtifact({
        artifactId: "art_raw_sensitive_output",
        generation: session.generation,
        offsetBytes: 0,
        sessionId: session.id,
      }),
    ).resolves.toMatchObject({ kind: "not_found" });

    const finished = await rpc.finishSensitiveInput({
      actor: human,
      expectedVersion: active?.version ?? 0,
      idempotencyKey: "m10-secret-finish",
      outcome: "completed",
      sensitiveInputId: action.sensitiveInputId,
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    expect(finished).toMatchObject({ status: "COMPLETED", version: 2 });
    const visible = await rpc.startExecute({
      actor: human,
      command: "printf 'VISIBLE_AFTER_SECRET\\n'",
      idempotencyKey: "m10-after-secret",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    expect((await rpc.waitExecution(visible.execution.id)).output).toContain(
      "VISIBLE_AFTER_SECRET",
    );
  }, 30_000);
});

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Runtime state");
}
