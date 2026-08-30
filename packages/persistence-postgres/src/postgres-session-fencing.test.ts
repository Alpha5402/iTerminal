import { randomUUID } from "node:crypto";

import type {
  DurableExecuteAdmission,
  DurableSessionEvent,
  RuntimeOwnerRecord,
  SessionFence,
} from "@iterminal/application";
import type { Actor, ExecuteAction, Execution, Session } from "@iterminal/domain";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresRuntimeDurability } from "./postgres-runtime-durability.js";
import { PostgresRuntimeOwnerRegistry } from "./postgres-runtime-owner-registry.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("M9.3 PostgreSQL Session fencing", () => {
  const durability = new PostgresRuntimeDurability(databaseUrl ?? "");
  const registry = new PostgresRuntimeOwnerRegistry(databaseUrl ?? "");
  const pool = new Pool({ connectionString: databaseUrl });
  let owner: RuntimeOwnerRecord;

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M9 fencing tests refuse to mutate any database except iterminal_test");
    }
    await durability.migrate();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox, runtime_workers RESTART IDENTITY CASCADE");
    owner = await registry.registerOwner({
      endpoint: "/private/tmp/iterminal-m93-persistence.sock",
      instanceId: `instance_${randomUUID()}`,
      leaseMilliseconds: 60_000,
      ownerId: "owner-m93-persistence",
    });
  });

  afterAll(async () => {
    await durability.close();
    await registry.close();
    await pool.end();
  });

  it("allocates monotonic tokens and rolls back a partial exact-set renewal", async () => {
    const left = sessionFixture(owner.ownerId);
    const right = sessionFixture(owner.ownerId);
    const leftFence = await durability.createSession(
      left,
      [eventFixture(left, "session.created")],
      owner,
      30_000,
    );
    const rightFence = await durability.createSession(
      right,
      [eventFixture(right, "session.created")],
      owner,
      30_000,
    );
    expect(BigInt(rightFence.fencingToken)).toBeGreaterThan(BigInt(leftFence.fencingToken));

    const renewed = await durability.renewSessionLeases(owner, [leftFence, rightFence], 30_000);
    expect(renewed.map((lease) => lease.version)).toEqual([2, 2]);
    expect(
      renewed.every(
        (lease) =>
          new Date(lease.leaseExpiresAt).getTime() <= new Date(owner.leaseExpiresAt).getTime(),
      ),
    ).toBe(true);

    const tampered: SessionFence = { ...rightFence, fencingToken: "9223372036854775807" };
    await expect(
      durability.renewSessionLeases(owner, [renewed[0] as SessionFence, tampered], 30_000),
    ).rejects.toMatchObject({ code: "SESSION_LEASE_LOST", retryable: false });
    const versions = await pool.query<{ version: string }>(
      `SELECT version::text FROM session_leases
        WHERE session_id IN ($1, $2) ORDER BY session_id`,
      [left.id, right.id],
    );
    expect(versions.rows.map((row) => row.version)).toEqual(["2", "2"]);
  });

  it("requires the expected Execution version under the same Session fence", async () => {
    const starting = sessionFixture(owner.ownerId);
    const fence = await durability.createSession(
      starting,
      [eventFixture(starting, "session.created")],
      owner,
      30_000,
    );
    const ready: Session = { ...starting, status: "READY" };
    await durability.markSessionReady(
      fence,
      ready,
      process.pid,
      eventFixture(ready, "session.shell_ready"),
      checkpointFixture(ready),
    );

    const admitted = executeAdmission(ready);
    await durability.acceptExecute(fence, admitted);
    const reserved: Session = {
      ...ready,
      activeExecutionId: admitted.execution.id,
      status: "RESERVED",
    };
    await durability.markExecutionWriteAttempted({
      action: admitted.action,
      event: eventFixture(reserved, "execution.write_attempted"),
      execution: admitted.execution,
      expectedExecutionVersion: 1,
      fence,
      session: reserved,
    });
    admitted.action.status = "RUNNING";
    admitted.execution.status = "RUNNING";
    admitted.execution.startedAt = new Date().toISOString();
    const running: Session = { ...reserved, status: "RUNNING" };
    await durability.markExecutionRunning({
      action: admitted.action,
      event: eventFixture(running, "execution.started"),
      execution: admitted.execution,
      expectedExecutionVersion: 1,
      fence,
      session: running,
    });

    admitted.action.status = "COMPLETED";
    admitted.execution.status = "COMPLETED";
    admitted.execution.exitCode = 0;
    admitted.execution.cwd = ready.workspaceRoot;
    admitted.execution.finishedAt = new Date().toISOString();
    admitted.execution.version = 2;
    const completed: Session = { ...ready, screenVersion: 3 };
    await expect(
      durability.finishExecution({
        action: admitted.action,
        events: [eventFixture(completed, "execution.completed")],
        execution: admitted.execution,
        expectedExecutionVersion: 1,
        fence,
        session: completed,
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
    expect(await executionState(admitted.execution.id)).toEqual({
      status: "RUNNING",
      version: "2",
    });

    await durability.finishExecution({
      action: admitted.action,
      events: [
        eventFixture(completed, "execution.completed"),
        eventFixture(completed, "session.shell_ready"),
      ],
      execution: admitted.execution,
      expectedExecutionVersion: 2,
      fence,
      session: completed,
    });
    expect(await executionState(admitted.execution.id)).toEqual({
      status: "COMPLETED",
      version: "3",
    });
  });

  async function executionState(
    executionId: string,
  ): Promise<{ readonly status: string; readonly version: string } | undefined> {
    const result = await pool.query<{ status: string; version: string }>(
      "SELECT status, version::text FROM executions WHERE id = $1",
      [executionId],
    );
    return result.rows[0];
  }
});

const actor: Actor = {
  client: "m93-fencing-test",
  id: "agent-m93-fencing",
  principal: "m93-fencing",
  type: "agent",
};

function sessionFixture(ownerId: string): Session {
  return {
    actionSequence: 0,
    createdAt: new Date().toISOString(),
    eventSequence: 0,
    generation: 1,
    id: `ses_${randomUUID()}`,
    ownerId,
    screenVersion: 0,
    shell: "zsh",
    status: "STARTING",
    workspaceRoot: "/tmp",
  };
}

function eventFixture(session: Session, type: string): DurableSessionEvent {
  return {
    id: `evt_${randomUUID()}`,
    observedAt: new Date().toISOString(),
    payload: {},
    sessionGeneration: session.generation,
    sessionId: session.id,
    type,
  };
}

function checkpointFixture(session: Session) {
  return {
    contentHash: "0".repeat(64),
    cwd: session.workspaceRoot,
    filteredEnvironment: {},
    observedAt: session.createdAt,
    sessionId: session.id,
    shell: session.shell,
    sourceGeneration: session.generation,
    version: 1,
    workspaceRoot: session.workspaceRoot,
  };
}

function executeAdmission(session: Session): DurableExecuteAdmission {
  const acceptedAt = new Date().toISOString();
  const action: ExecuteAction = {
    acceptedAt,
    actionSequence: 1,
    actor,
    command: "true",
    executionId: `exe_${randomUUID()}`,
    id: `act_${randomUUID()}`,
    idempotencyKey: `execute_${randomUUID()}`,
    requestHash: `hash_${randomUUID()}`,
    sessionGeneration: session.generation,
    sessionId: session.id,
    status: "DISPATCHING",
    type: "execute",
  };
  const execution: Execution = {
    actionId: action.id,
    actor,
    command: action.command,
    createdAt: acceptedAt,
    id: action.executionId,
    sessionGeneration: session.generation,
    sessionId: session.id,
    status: "DISPATCHING",
    version: 1,
  };
  return {
    acceptedEvent: eventFixture(session, "action.accepted"),
    action,
    dispatchingEvent: eventFixture(session, "action.dispatching"),
    execution,
  };
}
