import { randomUUID } from "node:crypto";

import type { Actor, InteractionState, RuntimeError, Session } from "@iterminal/domain";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresRuntimeDurability } from "./postgres-runtime-durability.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const human: Actor = {
  client: "postgres-guard-test",
  id: "human-postgres-guard",
  principal: "local-postgres-human",
  type: "human",
};

describeDatabase("PostgreSQL Interaction Guard state", () => {
  const durability = new PostgresRuntimeDurability(databaseUrl ?? "");
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M6.5 tests refuse to mutate any database except iterminal_test");
    }
    await durability.migrate();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    await durability.close();
    await pool.end();
  });

  it("commits state and Event atomically with one expected-version winner", async () => {
    const session = sessionFixture();
    await durability.createSession(session, [eventFixture(session, "session.created")]);
    const humanOnly: InteractionState = {
      policy: "human_only",
      sessionGeneration: session.generation,
      sessionId: session.id,
      version: 2,
    };
    const agentOnly: InteractionState = { ...humanOnly, policy: "agent_only" };
    const attempts = await Promise.allSettled([
      durability.saveInteractionState(
        humanOnly,
        1,
        eventFixture(session, "interaction.policy_changed", human),
      ),
      durability.saveInteractionState(
        agentOnly,
        1,
        eventFixture(session, "interaction.policy_changed", human),
      ),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status !== "rejected") throw new Error("Expected one rejected CAS");
    expect(rejected.reason).toMatchObject({
      code: "INTERACTION_GUARD_CHANGED",
      retryable: true,
    } satisfies Partial<RuntimeError>);

    const current = await pool.query<{
      input_policy: string;
      state_version: string;
    }>(
      `SELECT input_policy, state_version FROM interaction_guards
        WHERE session_id = $1 AND session_generation = $2`,
      [session.id, session.generation],
    );
    expect(current.rows[0]?.state_version).toBe("2");
    expect(["human_only", "agent_only"]).toContain(current.rows[0]?.input_policy);
    const events = await pool.query<{ count: string }>(
      `SELECT count(*) FROM session_events
        WHERE session_id = $1 AND event_type = 'interaction.policy_changed'`,
      [session.id],
    );
    expect(events.rows[0]?.count).toBe("1");
  });

  it("persists the full bounded Guard and rolls back an invalid renewal", async () => {
    const session = sessionFixture();
    await durability.createSession(session, [eventFixture(session, "session.created")]);
    const guarded: InteractionState = {
      guard: {
        acquiredAt: "2026-08-30T00:00:00.000Z",
        actor: human,
        expiresAt: "2026-08-30T00:00:00.500Z",
        id: "grd-postgres",
        maxRenewals: 3,
        reason: "raw batch",
        renewals: 0,
      },
      policy: "human_guarded",
      sessionGeneration: session.generation,
      sessionId: session.id,
      version: 2,
    };
    await durability.saveInteractionState(
      guarded,
      1,
      eventFixture(session, "interaction.guard_acquired", human),
    );
    const persisted = await pool.query<{
      guard_actor_id: string;
      guard_id: string;
      guard_max_renewals: number;
      guard_reason: string;
      guard_renewals: number;
    }>(
      `SELECT guard_id, guard_actor_id, guard_reason, guard_renewals, guard_max_renewals
         FROM interaction_guards WHERE session_id = $1 AND session_generation = $2`,
      [session.id, session.generation],
    );
    expect(persisted.rows[0]).toEqual({
      guard_actor_id: human.id,
      guard_id: "grd-postgres",
      guard_max_renewals: 3,
      guard_reason: "raw batch",
      guard_renewals: 0,
    });
    const activeGuard = guarded.guard;
    if (activeGuard === undefined) throw new Error("Expected guarded state");

    await expect(
      durability.saveInteractionState(
        {
          ...guarded,
          guard: { ...activeGuard, renewals: 4 },
          version: 3,
        },
        2,
        eventFixture(session, "interaction.guard_renewed", human),
      ),
    ).rejects.toThrow();
    const unchanged = await pool.query<{ state_version: string }>(
      "SELECT state_version FROM interaction_guards WHERE session_id = $1",
      [session.id],
    );
    expect(unchanged.rows[0]?.state_version).toBe("2");
    const invalidEvent = await pool.query<{ count: string }>(
      `SELECT count(*) FROM session_events
        WHERE session_id = $1 AND event_type = 'interaction.guard_renewed'`,
      [session.id],
    );
    expect(invalidEvent.rows[0]?.count).toBe("0");
  });
});

function sessionFixture(): Session {
  return {
    actionSequence: 0,
    createdAt: "2026-08-30T00:00:00.000Z",
    eventSequence: 0,
    generation: 1,
    id: `ses_${randomUUID()}`,
    ownerId: "owner-postgres-guard",
    screenVersion: 0,
    shell: "zsh",
    status: "STARTING",
    workspaceRoot: "/tmp",
  };
}

function eventFixture(session: Session, type: string, actor?: Actor) {
  return {
    id: `evt_${randomUUID()}`,
    observedAt: "2026-08-30T00:00:00.000Z",
    payload: {},
    sessionGeneration: session.generation,
    sessionId: session.id,
    type,
    ...(actor === undefined ? {} : { actor }),
  };
}
