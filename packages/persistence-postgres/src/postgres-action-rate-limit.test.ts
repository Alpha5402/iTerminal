import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
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

describeDatabase("M9.4 durable Action rate limits", () => {
  const repository = new PostgresRuntimeRepository(
    databaseUrl ?? "postgresql://localhost/iterminal_test",
    {
      actionRateLimitWindowMilliseconds: 100,
      actorActionRateLimit: 1,
      sessionActionRateLimit: 10,
    },
  );
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M9 rate-limit tests refuse to mutate any database except iterminal_test");
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

  it("does not charge idempotent replay and rolls back a rejected cross-Session Actor admission", async () => {
    const firstSession = await createSession(repository);
    const secondSession = await createSession(repository);
    const firstRequest = executeRequest(firstSession, "actor-rate-replay", "first");
    const accepted = await repository.acceptExecute(firstRequest);
    const replay = await repository.acceptExecute({
      ...firstRequest,
      actionId: `act_${randomUUID()}`,
      eventId: `evt_${randomUUID()}`,
      executionId: `exe_${randomUUID()}`,
      outboxId: `out_${randomUUID()}`,
    });
    expect(replay).toEqual({ ...accepted, replayed: true });

    const rejection = await captureRateLimited(
      repository.acceptExecute(executeRequest(secondSession, "actor-rate-replay", "second")),
    );
    expect(rejection).toMatchObject({
      code: "RATE_LIMITED",
      details: {
        limit: 1,
        subjectId: "actor-rate-replay",
        subjectKind: "actor",
        windowMilliseconds: 100,
      },
      retryable: true,
    });
    expect(await repository.inspectSession(secondSession)).toMatchObject({
      actionCount: 0,
      activeExecutionId: null,
      outboxCount: 0,
      status: "READY",
    });
    const bucket = await pool.query<{ action_count: string }>(
      `SELECT action_count::text
         FROM actor_action_rate_limit_buckets
        WHERE actor_id = 'actor-rate-replay'`,
    );
    expect(bucket.rows).toEqual([{ action_count: "1" }]);
  });

  it("rolls counter updates back with admission and resets the window using database time", async () => {
    const rolledBackSession = await createSession(repository);
    const failed = executeRequest(rolledBackSession, "actor-rate-rollback", "rollback");
    await expect(
      repository.acceptExecute({ ...failed, failpoint: "before_commit" }),
    ).rejects.toThrow("Injected failure before commit");
    expect(
      (
        await pool.query(
          "SELECT 1 FROM actor_action_rate_limit_buckets WHERE actor_id = 'actor-rate-rollback'",
        )
      ).rowCount,
    ).toBe(0);
    await repository.acceptExecute(failed);

    const firstSession = await createSession(repository);
    const secondSession = await createSession(repository);
    await repository.acceptExecute(executeRequest(firstSession, "actor-rate-window", "window-a"));
    await expect(
      repository.acceptExecute(executeRequest(secondSession, "actor-rate-window", "window-b")),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await delay(150);
    await repository.acceptExecute(executeRequest(secondSession, "actor-rate-window", "window-b"));
    const bucket = await pool.query<{ action_count: string }>(
      `SELECT action_count::text
         FROM actor_action_rate_limit_buckets
        WHERE actor_id = 'actor-rate-window'`,
    );
    expect(bucket.rows).toEqual([{ action_count: "1" }]);
  });
});

async function createSession(repository: PostgresRuntimeRepository): Promise<string> {
  const id = `ses_${randomUUID()}`;
  await repository.createReadySession({
    createdAt: new Date(),
    generation: 1,
    id,
    integrationVersion: "m9-rate-limit-v1",
    ownerId: "owner-m9-rate-limit",
    shell: "zsh",
    shellPid: process.pid,
    workspaceRoot: "/tmp/iterminal-test",
  });
  return id;
}

function executeRequest(
  sessionId: string,
  actorId: string,
  suffix: string,
): AcceptExecuteTransaction {
  return {
    acceptedAt: new Date(),
    actionId: `act_${randomUUID()}`,
    actor: {
      client: "m9-rate-limit-test",
      id: actorId,
      principal: actorId,
      capabilities: ACTOR_CAPABILITY_PROFILES.agent,
      type: "agent",
    },
    command: "true",
    eventId: `evt_${randomUUID()}`,
    executionId: `exe_${randomUUID()}`,
    generation: 1,
    idempotencyKey: `rate-${suffix}`,
    outboxId: `out_${randomUUID()}`,
    requestHash: `hash-${suffix}`,
    sessionId,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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
