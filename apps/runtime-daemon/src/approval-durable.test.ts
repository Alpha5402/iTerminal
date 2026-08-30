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
const agent: Actor = {
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  client: "m10-durable-agent",
  id: "agent-m10-durable",
  principal: "local-m10-agent",
  type: "agent",
};
const human: Actor = {
  capabilities: ACTOR_CAPABILITY_PROFILES.human,
  client: "m10-durable-human",
  id: "human-m10-durable",
  principal: "local-m10-human",
  type: "human",
};

describeDatabase("M10.3 durable Execute Approval", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const fixtures: string[] = [];
  let daemon: RuntimeDaemonHandle | undefined;

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M10 Approval tests refuse to mutate any database except iterminal_test");
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

  it("requires, decides, consumes, and exactly replays one bound Agent Execute", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m10-approval-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    daemon = await startRuntimeDaemon({
      agentExecuteApproval: "required",
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-m10-approval",
      socketPath: join(root, "runtime.sock"),
    });
    const rpc = new UnixRuntimeClient(daemon.socketPath);
    const session = await rpc.createSession({
      idempotencyKey: "m10-approval-session",
      shell: "zsh",
      workspaceRoot: workspace,
    });
    const command = "printf 'approved-path\\n'";
    const actionIdempotencyKey = "m10-approved-execute";
    await expect(
      rpc.startExecute({
        actor: agent,
        command,
        idempotencyKey: actionIdempotencyKey,
        sessionGeneration: session.generation,
        sessionId: session.id,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });

    const approval = await rpc.requestExecuteApproval({
      actionIdempotencyKey,
      actor: agent,
      command,
      reason: "Run the exact reviewed printf",
      requestIdempotencyKey: "m10-approval-request",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    expect(approval).toMatchObject({ status: "PENDING", version: 1 });
    await expect(
      rpc.startExecute({
        actor: agent,
        approvalId: approval.id,
        command: "printf 'changed\\n'",
        idempotencyKey: actionIdempotencyKey,
        sessionGeneration: session.generation,
        sessionId: session.id,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    const decided = await rpc.decideApproval({
      actor: human,
      approvalId: approval.id,
      decision: "approve",
      expectedVersion: approval.version,
      idempotencyKey: "m10-approval-decision",
      reason: "Exact proposal reviewed",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    expect(decided).toMatchObject({ status: "APPROVED", version: 2 });

    const request = {
      actor: agent,
      approvalId: approval.id,
      command,
      idempotencyKey: actionIdempotencyKey,
      sessionGeneration: session.generation,
      sessionId: session.id,
    } as const;
    const started = await rpc.startExecute(request);
    const completed = await rpc.waitExecution(started.execution.id);
    expect(completed).toMatchObject({ exitCode: 0, status: "COMPLETED" });
    expect(completed.output).toContain("approved-path");
    expect(await rpc.getApproval({ ...request, approvalId: approval.id })).toMatchObject({
      consumedActionId: started.action.id,
      status: "CONSUMED",
      version: 3,
    });
    const replay = await rpc.startExecute(request);
    expect(replay.action.id).toBe(started.action.id);
    expect(replay.execution.id).toBe(started.execution.id);

    const durable = await pool.query<{ event_type: string; payload: unknown }>(
      `SELECT event_type, payload FROM session_events
        WHERE session_id = $1 AND event_type LIKE 'approval.%'
        ORDER BY event_sequence`,
      [session.id],
    );
    expect(durable.rows.map((row) => row.event_type)).toEqual([
      "approval.requested",
      "approval.approved",
      "approval.consumed",
    ]);
    expect(JSON.stringify(durable.rows)).not.toContain(command);
  }, 30_000);
});
