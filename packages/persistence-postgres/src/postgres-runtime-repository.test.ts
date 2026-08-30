import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import type { Approval } from "@iterminal/domain";
import { randomUUID } from "node:crypto";

import { RuntimeError } from "@iterminal/domain";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PostgresRuntimeRepository,
  type AcceptExecuteTransaction,
} from "./postgres-runtime-repository.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("PostgresRuntimeRepository", () => {
  const repository = new PostgresRuntimeRepository(
    databaseUrl ?? "postgresql://localhost/iterminal_test",
  );
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M2 tests refuse to mutate any database except iterminal_test");
    }
    await repository.migrate();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox RESTART IDENTITY CASCADE");
    await pool.query(
      `UPDATE retention_policies
          SET max_age_days = 7, max_events_per_generation = 100000,
              cleanup_batch_size = 10000, updated_at = now()
        WHERE scope = 'default'`,
    );
  });

  afterAll(async () => {
    await repository.close();
    await pool.end();
  });

  it("allows exactly one of 100 concurrent READY reservations", async () => {
    const session = await createSession(repository);
    const attempts = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) =>
        repository.acceptExecute(executeRequest(session.id, `actor-${index.toString()}`)),
      ),
    );
    const accepted = attempts.filter((result) => result.status === "fulfilled");
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(99);
    expect(
      rejected.every(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof RuntimeError &&
          result.reason.code === "PTY_BUSY",
      ),
    ).toBe(true);
    const state = await repository.inspectSession(session.id);
    expect(state).toMatchObject({
      actionCount: 1,
      eventCount: 1,
      executionStatus: "DISPATCHING",
      outboxCount: 1,
      status: "RESERVED",
    });
  }, 20_000);

  it("replays matching idempotency and rejects a changed request hash", async () => {
    const session = await createSession(repository);
    const request = executeRequest(session.id, "agent-idempotent");
    const accepted = await repository.acceptExecute(request);
    const replayed = await repository.acceptExecute({
      ...request,
      actionId: `act_${randomUUID()}`,
      eventId: `evt_${randomUUID()}`,
      executionId: `exe_${randomUUID()}`,
      outboxId: `out_${randomUUID()}`,
    });
    expect(replayed).toEqual({ ...accepted, replayed: true });
    await expect(
      repository.acceptExecute({ ...request, requestHash: "different-hash" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("keeps durable Actor identity immutable across Sessions", async () => {
    const firstSession = await createSession(repository);
    const secondSession = await createSession(repository);
    const actorId = "agent-immutable";
    await repository.acceptExecute(executeRequest(firstSession.id, actorId));

    const conflicting = executeRequest(secondSession.id, actorId);
    await expect(
      repository.acceptExecute({
        ...conflicting,
        actor: { ...conflicting.actor, principal: "changed-principal" },
      }),
    ).rejects.toMatchObject({ code: "ACTOR_IDENTITY_CONFLICT" });
    expect(await repository.inspectSession(secondSession.id)).toMatchObject({
      actionCount: 0,
      activeExecutionId: null,
      status: "READY",
    });
    const actor = await pool.query<{
      capabilities: string[];
      principal: string;
    }>("SELECT principal, capabilities FROM actors WHERE id = $1", [actorId]);
    expect(actor.rows[0]).toEqual({
      capabilities: ACTOR_CAPABILITY_PROFILES.agent,
      principal: actorId,
    });
    await expect(
      pool.query(
        `UPDATE actors
            SET capabilities = ARRAY['terminal.input', 'session.execute']::text[]
          WHERE id = $1`,
        [actorId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("coalesces concurrent matching idempotency before applying Outbox capacity", async () => {
    const session = await createSession(repository);
    const request = executeRequest(session.id, "agent-concurrent-idempotent");
    const [left, right] = await Promise.all([
      repository.acceptExecute(request),
      repository.acceptExecute({
        ...request,
        actionId: `act_${randomUUID()}`,
        eventId: `evt_${randomUUID()}`,
        executionId: `exe_${randomUUID()}`,
        outboxId: `out_${randomUUID()}`,
      }),
    ]);
    expect(left.actionId).toBe(right.actionId);
    expect(left.executionId).toBe(right.executionId);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    expect(await repository.inspectSession(session.id)).toMatchObject({
      actionCount: 1,
      outboxCount: 1,
      status: "RESERVED",
    });
  });

  it("rolls back all rows when failure occurs before commit", async () => {
    const session = await createSession(repository);
    await expect(
      repository.acceptExecute({
        ...executeRequest(session.id, "agent-rollback"),
        failpoint: "before_commit",
      }),
    ).rejects.toThrow("Injected failure before commit");
    expect(await repository.inspectSession(session.id)).toMatchObject({
      actionCount: 0,
      activeExecutionId: null,
      eventCount: 0,
      outboxCount: 0,
      status: "READY",
    });
  });

  it("atomically consumes one approved proposal with Execute admission", async () => {
    const session = await createSession(repository);
    const execute = executeRequest(session.id, "agent-approved");
    const approval = approvalFixture(execute);
    const requested = await repository.requestApproval({
      approval,
      eventId: `evt_${randomUUID()}`,
    });
    expect(requested).toMatchObject({
      approval: {
        ...approval,
        expiresAt: expect.any(String) as string,
        requestedAt: expect.any(String) as string,
      },
      replayed: false,
    });
    const replayedRequest = await repository.requestApproval({
      approval: { ...approval, id: `apr_${randomUUID()}` },
      eventId: `evt_${randomUUID()}`,
    });
    expect(replayedRequest).toEqual({ approval: requested.approval, replayed: true });

    const decided = await repository.decideApproval({
      approvalId: approval.id,
      approver: {
        capabilities: ACTOR_CAPABILITY_PROFILES.human,
        client: "m10-test",
        id: "human-approver",
        principal: "human-approver",
        type: "human",
      },
      decidedAt: new Date(),
      decision: "approve",
      decisionIdempotencyKey: "approve-once",
      decisionReason: "Reviewed exact command",
      decisionRequestHash: "d".repeat(64),
      eventId: `evt_${randomUUID()}`,
      expectedVersion: 1,
      sessionGeneration: 1,
      sessionId: session.id,
    });
    expect(decided.approval).toMatchObject({ status: "APPROVED", version: 2 });

    const admission = {
      ...execute,
      approvalConsumption: {
        actionRequestHash: approval.actionRequestHash,
        approvalId: approval.id,
        consumedAt: new Date(),
        eventId: `evt_${randomUUID()}`,
      },
    } satisfies AcceptExecuteTransaction;
    await expect(
      repository.acceptExecute({ ...admission, failpoint: "before_commit" }),
    ).rejects.toThrow("Injected failure before commit");
    expect(await repository.getApproval(session.id, 1, approval.id)).toMatchObject({
      status: "APPROVED",
      version: 2,
    });
    expect(await repository.inspectSession(session.id)).toMatchObject({
      actionCount: 0,
      status: "READY",
    });

    const accepted = await repository.acceptExecute(admission);
    expect(await repository.getApproval(session.id, 1, approval.id)).toMatchObject({
      consumedActionId: accepted.actionId,
      status: "CONSUMED",
      version: 3,
    });
    const replay = await repository.acceptExecute({
      ...admission,
      actionId: `act_${randomUUID()}`,
      eventId: `evt_${randomUUID()}`,
      executionId: `exe_${randomUUID()}`,
      outboxId: `out_${randomUUID()}`,
    });
    expect(replay).toEqual({ ...accepted, replayed: true });
    await expect(
      repository.acceptExecute({
        ...executeRequest(session.id, "agent-approved"),
        approvalConsumption: {
          ...admission.approvalConsumption,
          eventId: `evt_${randomUUID()}`,
        },
        idempotencyKey: "different-action",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    const action = await pool.query<{ payload: { approvalId?: string; command?: string } }>(
      "SELECT payload FROM actions WHERE id = $1",
      [accepted.actionId],
    );
    expect(action.rows[0]?.payload).toEqual({
      approvalId: approval.id,
      command: execute.command,
    });
  });

  it("marks lost live generations BROKEN and ambiguous executions UNKNOWN", async () => {
    const session = await createSession(repository);
    await repository.acceptExecute(executeRequest(session.id, "agent-crash"));
    const recovery = await repository.recoverLostOwner(session.ownerId, "runtime restart");
    expect(recovery).toEqual({ brokenSessions: 1, unknownExecutions: 1 });
    expect(await repository.inspectSession(session.id)).toMatchObject({
      activeExecutionId: null,
      executionStatus: "UNKNOWN",
      status: "BROKEN",
    });
  });

  it("keeps newest snapshot/checkpoint facts and allocates unique event sequences", async () => {
    const session = await createSession(repository);
    const newer = new Date("2026-08-30T12:00:00.000Z");
    const older = new Date("2026-08-30T11:00:00.000Z");
    expect(
      await repository.upsertSnapshot({
        confidence: "observed",
        cwd: "/new",
        generation: 1,
        observedAt: newer,
        screenVersion: 2,
        sessionId: session.id,
      }),
    ).toBe(true);
    expect(
      await repository.upsertSnapshot({
        confidence: "stale",
        cwd: "/old",
        generation: 1,
        observedAt: older,
        screenVersion: 1,
        sessionId: session.id,
      }),
    ).toBe(false);
    expect(
      await repository.upsertCheckpoint({
        checkpointVersion: 1,
        contentHash: "new-hash",
        cwd: "/new",
        filteredEnv: { LANG: "en_US.UTF-8" },
        observedAt: newer,
        sessionId: session.id,
        shell: "zsh",
        sourceGeneration: 1,
        workspaceRoot: "/new",
      }),
    ).toBe(true);
    expect(
      await repository.upsertCheckpoint({
        checkpointVersion: 1,
        contentHash: "old-hash",
        cwd: "/old",
        filteredEnv: {},
        observedAt: older,
        sessionId: session.id,
        shell: "zsh",
        sourceGeneration: 1,
        workspaceRoot: "/old",
      }),
    ).toBe(false);

    const sequences = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        repository.appendOutputChunk({
          createdAt: new Date(),
          data: `chunk-${index.toString()}`,
          eventId: `evt_${randomUUID()}`,
          generation: 1,
          sessionId: session.id,
        }),
      ),
    );
    expect(new Set(sequences).size).toBe(20);
    expect(Math.min(...sequences)).toBe(1);
    expect(Math.max(...sequences)).toBe(20);

    const facts = await pool.query<{
      checkpoint_cwd: string;
      snapshot_cwd: string;
    }>(
      `SELECT s.cwd AS snapshot_cwd, c.cwd AS checkpoint_cwd
         FROM session_snapshots s
         JOIN shell_checkpoints c
           ON c.session_id = s.session_id AND c.source_generation = s.session_generation
        WHERE s.session_id = $1`,
      [session.id],
    );
    expect(facts.rows[0]).toEqual({ checkpoint_cwd: "/new", snapshot_cwd: "/new" });
  });

  it("enforces the minimal event quota", async () => {
    const session = await createSession(repository);
    await pool.query(
      "UPDATE retention_policies SET max_age_days = 7, max_events_per_generation = 5 WHERE scope = 'default'",
    );
    for (let index = 0; index < 10; index += 1) {
      await repository.appendOutputChunk({
        createdAt: new Date(),
        data: `retained-${index.toString()}`,
        eventId: `evt_${randomUUID()}`,
        generation: 1,
        sessionId: session.id,
      });
    }
    expect(await repository.applyRetention(new Date())).toBe(5);
    expect((await repository.inspectSession(session.id)).eventCount).toBe(5);
  });
});

async function createSession(repository: PostgresRuntimeRepository): Promise<{
  readonly id: string;
  readonly ownerId: string;
}> {
  const id = `ses_${randomUUID()}`;
  const ownerId = `owner_${randomUUID()}`;
  await repository.createReadySession({
    createdAt: new Date(),
    generation: 1,
    id,
    integrationVersion: "m2-test-v1",
    ownerId,
    shell: "zsh",
    shellPid: process.pid,
    workspaceRoot: "/tmp/iterminal-test",
  });
  return { id, ownerId };
}

function executeRequest(sessionId: string, actorId: string): AcceptExecuteTransaction {
  return {
    acceptedAt: new Date(),
    actionId: `act_${randomUUID()}`,
    actor: {
      client: "m2-test",
      id: actorId,
      principal: actorId,
      capabilities: ACTOR_CAPABILITY_PROFILES.agent,
      type: "agent",
    },
    command: "sleep 10",
    eventId: `evt_${randomUUID()}`,
    executionId: `exe_${randomUUID()}`,
    generation: 1,
    idempotencyKey: `idem-${actorId}`,
    outboxId: `out_${randomUUID()}`,
    requestHash: `hash-${actorId}`,
    sessionId,
  };
}

function approvalFixture(execute: AcceptExecuteTransaction): Approval {
  const requestedAt = new Date();
  return {
    actionIdempotencyKey: execute.idempotencyKey,
    actionRequestHash: "a".repeat(64),
    command: execute.command,
    expiresAt: new Date(requestedAt.getTime() + 300_000).toISOString(),
    id: `apr_${randomUUID()}`,
    operation: "execution.start",
    reason: "Needs Human confirmation",
    requestHash: "b".repeat(64),
    requestIdempotencyKey: `approval-${execute.idempotencyKey}`,
    requestedAt: requestedAt.toISOString(),
    requester: execute.actor,
    sessionGeneration: execute.generation,
    sessionId: execute.sessionId,
    status: "PENDING",
    version: 1,
  };
}
