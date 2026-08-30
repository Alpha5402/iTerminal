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
  const repository = new PostgresRuntimeRepository(databaseUrl ?? "");
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
