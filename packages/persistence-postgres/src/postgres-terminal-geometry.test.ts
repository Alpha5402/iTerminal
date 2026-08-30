import { randomUUID } from "node:crypto";

import type { Actor, ResizeAction, RuntimeError, Session } from "@iterminal/domain";
import type { RuntimeOwnerRecord } from "@iterminal/application";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresRuntimeDurability } from "./postgres-runtime-durability.js";
import { PostgresRuntimeOwnerRegistry } from "./postgres-runtime-owner-registry.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("PostgreSQL controlled terminal geometry", () => {
  const durability = new PostgresRuntimeDurability(databaseUrl ?? "");
  const registry = new PostgresRuntimeOwnerRegistry(databaseUrl ?? "");
  const pool = new Pool({ connectionString: databaseUrl });
  let owner: RuntimeOwnerRecord;

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M6.6 tests refuse to mutate any database except iterminal_test");
    }
    await durability.migrate();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox, runtime_workers RESTART IDENTITY CASCADE");
    owner = await registry.registerOwner({
      endpoint: "/private/tmp/iterminal-geometry-test.sock",
      instanceId: `geometry_${randomUUID()}`,
      leaseMilliseconds: 60_000,
      ownerId: "owner-postgres-geometry",
    });
  });

  afterAll(async () => {
    await durability.close();
    await registry.close();
    await pool.end();
  });

  it("admits exactly one concurrent resize for one expected geometry version", async () => {
    const starting = sessionFixture();
    const fence = await durability.createSession(
      starting,
      [eventFixture(starting, "session.created")],
      owner,
      60_000,
    );
    const ready: Session = { ...starting, status: "READY" };
    await durability.markSessionReady(
      fence,
      ready,
      process.pid,
      eventFixture(ready, "session.ready"),
      {
        contentHash: "0".repeat(64),
        cwd: ready.workspaceRoot,
        filteredEnvironment: {},
        observedAt: ready.createdAt,
        sessionId: ready.id,
        shell: ready.shell,
        sourceGeneration: ready.generation,
        version: 1,
        workspaceRoot: ready.workspaceRoot,
      },
    );
    const left = resizeFixture(ready, actorFixture("left"), 96, 30);
    const right = resizeFixture(ready, actorFixture("right"), 100, 32);

    const attempts = await Promise.allSettled([
      durability.acceptResize(fence, left, eventFixture(ready, "action.accepted", left)),
      durability.acceptResize(fence, right, eventFixture(ready, "action.accepted", right)),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status !== "rejected") throw new Error("Expected one rejected resize CAS");
    expect(rejected.reason).toMatchObject({
      code: "GEOMETRY_CHANGED",
      retryable: true,
    } satisfies Partial<RuntimeError>);

    const durable = await pool.query<{
      action_count: string;
      geometry_version: string;
      terminal_columns: number;
      terminal_rows: number;
    }>(
      `SELECT count(a.id)::text AS action_count,
              s.geometry_version::text, s.terminal_columns, s.terminal_rows
         FROM sessions s LEFT JOIN actions a ON a.session_id = s.id
        WHERE s.id = $1
        GROUP BY s.geometry_version, s.terminal_columns, s.terminal_rows`,
      [ready.id],
    );
    expect(durable.rows[0]).toMatchObject({ action_count: "1", geometry_version: "2" });
    expect([
      { terminal_columns: 96, terminal_rows: 30 },
      { terminal_columns: 100, terminal_rows: 32 },
    ]).toContainEqual({
      terminal_columns: durable.rows[0]?.terminal_columns,
      terminal_rows: durable.rows[0]?.terminal_rows,
    });
  });
});

function sessionFixture(): Session {
  return {
    actionSequence: 0,
    createdAt: "2026-08-30T00:00:00.000Z",
    eventSequence: 0,
    generation: 1,
    id: `ses_${randomUUID()}`,
    ownerId: "owner-postgres-geometry",
    screenVersion: 0,
    shell: "zsh",
    status: "STARTING",
    workspaceRoot: "/tmp",
  };
}

function actorFixture(name: string): Actor {
  return {
    client: `geometry-${name}`,
    id: `agent-geometry-${name}`,
    principal: `geometry-${name}`,
    type: "agent",
  };
}

function resizeFixture(
  session: Session,
  actor: Actor,
  columns: number,
  rows: number,
): ResizeAction {
  return {
    acceptedAt: "2026-08-30T00:00:01.000Z",
    actionSequence: 1,
    actor,
    columns,
    expectedGeometryVersion: 1,
    id: `act_${randomUUID()}`,
    idempotencyKey: `resize-${actor.id}`,
    requestHash: `hash-${actor.id}`,
    rows,
    sessionGeneration: session.generation,
    sessionId: session.id,
    status: "ACCEPTED",
    type: "resize",
  };
}

function eventFixture(session: Session, type: string, action?: ResizeAction) {
  return {
    id: `evt_${randomUUID()}`,
    observedAt: "2026-08-30T00:00:01.000Z",
    payload: {},
    sessionGeneration: session.generation,
    sessionId: session.id,
    type,
    ...(action === undefined ? {} : { action, actor: action.actor }),
  };
}
