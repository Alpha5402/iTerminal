import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresRuntimeRepository } from "./postgres-runtime-repository.js";
import { PostgresStorageMaintenanceRepository } from "./storage-maintenance.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("PostgresStorageMaintenanceRepository", () => {
  const databaseTarget = databaseUrl ?? "postgresql://localhost/iterminal_test";
  const maintenance = new PostgresStorageMaintenanceRepository(databaseTarget);
  const runtime = new PostgresRuntimeRepository(databaseTarget);
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M10.12 tests refuse to mutate any database except iterminal_test");
    }
    await maintenance.migrate();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox, consumer_inbox RESTART IDENTITY CASCADE");
    await pool.query(
      `UPDATE durable_fact_retention_policies
          SET retention_milliseconds = 86400000,
              cleanup_batch_size = 100,
              updated_at = now()
        WHERE scope = 'default'`,
    );
    await pool.query(
      `UPDATE database_capacity_policies
          SET max_bytes = 10737418240, warning_percent = 80, updated_at = now()
        WHERE scope = 'default'`,
    );
  });

  afterAll(async () => {
    await maintenance.close();
    await runtime.close();
    await pool.end();
  });

  it("deletes only terminal unreferenced facts and preserves live recovery/idempotency rows", async () => {
    const old = "2026-08-20T00:00:00.000Z";
    const recent = "2026-08-31T11:00:00.000Z";
    await pool.query(
      `INSERT INTO actors (id, actor_type, principal, client, capabilities, created_at)
       VALUES
         ('agent-retention', 'agent', 'agent-retention', 'test', $1, $2),
         ('human-retention', 'human', 'human-retention', 'test', $3, $2)`,
      [ACTOR_CAPABILITY_PROFILES.agent, old, ACTOR_CAPABILITY_PROFILES.human],
    );
    await pool.query(
      `INSERT INTO sessions
         (id, current_generation, status, shell, workspace_root, owner_id, created_at, updated_at)
       VALUES
         ('session-stale', 2, 'READY', 'zsh', '/tmp', 'owner-retention', $1, $1),
         ('session-live', 1, 'READY', 'zsh', '/tmp', 'owner-retention', $1, $1)`,
      [old],
    );
    await pool.query(
      `INSERT INTO session_generations
         (session_id, generation, owner_id, integration_version, status,
          next_event_sequence, started_at)
       VALUES
         ('session-stale', 1, 'owner-retention', 'test', 'CLOSED', 1, $1),
         ('session-stale', 2, 'owner-retention', 'test', 'READY', 0, $1),
         ('session-live', 1, 'owner-retention', 'test', 'READY', 0, $1)`,
      [old],
    );
    await pool.query(
      `INSERT INTO actions
         (id, session_id, session_generation, actor_id, kind, action_sequence,
          idempotency_key, request_hash, payload, status, accepted_at, updated_at)
       VALUES
         ('action-eligible', 'session-stale', 1, 'agent-retention', 'execute', 1,
          'eligible-key', 'eligible-hash', '{"command":"eligible"}', 'COMPLETED', $1, $1),
         ('action-input', 'session-stale', 1, 'agent-retention', 'input', 2,
          'input-key', 'input-hash', '{}', 'COMPLETED', $1, $1),
         ('action-event-pinned', 'session-stale', 1, 'agent-retention', 'execute', 3,
          'event-key', 'event-hash', '{"command":"event"}', 'COMPLETED', $1, $1),
         ('action-live', 'session-live', 1, 'agent-retention', 'execute', 1,
          'live-key', 'live-hash', '{"command":"live"}', 'COMPLETED', $1, $1)`,
      [old],
    );
    await pool.query(
      `INSERT INTO executions
         (id, action_id, session_id, session_generation, owner_id, status, command,
          exit_code, cwd, started_at, finished_at)
       VALUES
         ('execution-eligible', 'action-eligible', 'session-stale', 1,
          'owner-retention', 'COMPLETED', 'eligible', 0, '/tmp', $1, $1),
         ('execution-event-pinned', 'action-event-pinned', 'session-stale', 1,
          'owner-retention', 'COMPLETED', 'event', 0, '/tmp', $1, $1),
         ('execution-live', 'action-live', 'session-live', 1,
          'owner-retention', 'COMPLETED', 'live', 0, '/tmp', $1, $1)`,
      [old],
    );
    await pool.query(
      `INSERT INTO session_events
         (id, session_id, session_generation, event_sequence, event_type,
          action_id, execution_id, actor_id, payload, created_at, search_text)
       VALUES
         ('event-action-pin', 'session-stale', 1, 1, 'action.completed',
          'action-event-pinned', 'execution-event-pinned', 'agent-retention', '{}', $1, '')`,
      [old],
    );
    await pool.query(
      `INSERT INTO approvals
         (id, session_id, session_generation, operation, requester_actor_id,
          action_idempotency_key, action_request_hash, command, reason,
          request_idempotency_key, request_hash, status, version, requested_at, expires_at,
          approver_actor_id, decided_at, decision_idempotency_key, decision_reason,
          decision_request_hash, consumed_action_id, consumed_at)
       VALUES
         ('approval-consumed', 'session-stale', 1, 'execution.start', 'agent-retention',
          'eligible-key', repeat('a', 64), 'eligible', 'old consumed approval',
          'approval-consumed-key', repeat('b', 64), 'CONSUMED', 3, $1, $1::timestamptz + interval '5 minutes',
          'human-retention', $1, 'decision-consumed', 'approved', repeat('c', 64),
          'action-eligible', $1),
         ('approval-expired', 'session-stale', 1, 'execution.start', 'agent-retention',
          'expired-key', repeat('d', 64), 'expired', 'old approved approval',
          'approval-expired-key', repeat('e', 64), 'APPROVED', 2, $1, $1::timestamptz + interval '5 minutes',
          'human-retention', $1, 'decision-expired', 'approved', repeat('f', 64),
          NULL, NULL),
         ('approval-recent', 'session-stale', 1, 'execution.start', 'agent-retention',
          'recent-key', repeat('1', 64), 'recent', 'recent denied approval',
          'approval-recent-key', repeat('2', 64), 'DENIED', 2, $2, $2::timestamptz + interval '5 minutes',
          'human-retention', $2, 'decision-recent', 'denied', repeat('3', 64),
          NULL, NULL)`,
      [old, recent],
    );
    await pool.query(
      `INSERT INTO outbox
         (id, aggregate_type, aggregate_id, event_type, payload, created_at, published_at)
       VALUES
         ('outbox-old', 'session', 'session-stale', 'ExecutionReady',
          '{"executionId":"execution-eligible","generation":1}', $1, $1),
         ('outbox-pending', 'session', 'session-stale', 'ExecutionReady',
          '{"executionId":"execution-event-pinned","generation":1}', $1, NULL),
         ('outbox-recent', 'session', 'session-live', 'ExecutionReady',
          '{"executionId":"execution-live","generation":1}', $2, $2)`,
      [old, recent],
    );
    await pool.query(
      `INSERT INTO consumer_inbox
         (consumer_id, message_id, payload_hash, status, attempts, outcome,
          first_received_at, updated_at, completed_at)
       VALUES
         ('worker', 'outbox-old', 'hash-old', 'COMPLETED', 1, 'DELIVERED', $1, $1, $1),
         ('worker', 'outbox-pending', 'hash-pending', 'COMPLETED', 1, 'DELIVERED', $1, $1, $1),
         ('worker', 'processing-old', 'hash-processing', 'PROCESSING', 1, NULL, $1, $1, NULL)`,
      [old],
    );

    const result = await maintenance.maintainDurableFacts(new Date("2026-08-31T12:00:00.000Z"));

    expect(result).toMatchObject({
      deletedActions: 2,
      deletedApprovals: 2,
      deletedInboxRows: 1,
      deletedOutboxRows: 1,
      policy: { cleanupBatchSize: 100, retentionMilliseconds: 86_400_000 },
    });
    await expectCounts({ actions: 2, approvals: 1, inbox: 2, outbox: 2 });
    expect(await ids("actions")).toEqual(["action-event-pinned", "action-live"]);
    expect(await ids("executions")).toEqual(["execution-event-pinned", "execution-live"]);

    const liveReplay = await runtime.acceptExecute({
      acceptedAt: new Date("2026-08-31T12:01:00.000Z"),
      actionId: "action-live-replay",
      actor: agent("agent-retention"),
      command: "live",
      eventId: "event-live-replay",
      executionId: "execution-live-replay",
      generation: 1,
      idempotencyKey: "live-key",
      outboxId: "outbox-live-replay",
      requestHash: "live-hash",
      sessionId: "session-live",
    });
    expect(liveReplay).toMatchObject({ actionId: "action-live", replayed: true });

    await expect(
      runtime.acceptExecute({
        acceptedAt: new Date("2026-08-31T12:01:00.000Z"),
        actionId: "action-stale-retry",
        actor: agent("agent-retention"),
        command: "eligible",
        eventId: "event-stale-retry",
        executionId: "execution-stale-retry",
        generation: 1,
        idempotencyKey: "eligible-key",
        outboxId: "outbox-stale-retry",
        requestHash: "eligible-hash",
        sessionId: "session-stale",
      }),
    ).rejects.toMatchObject({ code: "SESSION_GENERATION_CHANGED" });
    await expectCounts({ actions: 2, approvals: 1, inbox: 2, outbox: 2 });
  });

  it("serializes concurrent maintenance and limits every fact class to one configured batch", async () => {
    const old = "2026-08-20T00:00:00.000Z";
    await pool.query(
      `UPDATE durable_fact_retention_policies
          SET cleanup_batch_size = 1
        WHERE scope = 'default'`,
    );
    await pool.query(
      `INSERT INTO outbox
         (id, aggregate_type, aggregate_id, event_type, payload, created_at, published_at)
       VALUES
         ('bounded-one', 'session', 'missing', 'settled', '{}', $1, $1),
         ('bounded-two', 'session', 'missing', 'settled', '{}', $1, $1)`,
      [old],
    );

    const competitor = new PostgresStorageMaintenanceRepository(databaseTarget);
    try {
      const results = await Promise.all([
        maintenance.maintainDurableFacts(new Date("2026-08-31T12:00:00.000Z")),
        competitor.maintainDurableFacts(new Date("2026-08-31T12:00:00.000Z")),
      ]);
      expect(results.map((result) => result.deletedOutboxRows)).toEqual([1, 1]);
      expect(await count("outbox")).toBe(0);
    } finally {
      await competitor.close();
    }
  });

  it("reports exact PostgreSQL allocation with healthy, warning, and critical states", async () => {
    const baseline = await maintenance.inspectDatabaseCapacity();
    const used = BigInt(baseline.usedBytes);
    expect(used).toBeGreaterThan(0n);
    expect(baseline.status).toBe("HEALTHY");

    const warningMaximum = Number(used * 2n + 1_000_000n);
    await pool.query(
      `UPDATE database_capacity_policies
          SET max_bytes = $1, warning_percent = 1, updated_at = now()
        WHERE scope = 'default'`,
      [warningMaximum],
    );
    expect(await maintenance.inspectDatabaseCapacity()).toMatchObject({
      policy: { maxBytes: warningMaximum, warningPercent: 1 },
      status: "WARNING",
    });

    await pool.query(
      `UPDATE database_capacity_policies
          SET max_bytes = 1, warning_percent = 80, updated_at = now()
        WHERE scope = 'default'`,
    );
    const critical = await maintenance.inspectDatabaseCapacity();
    expect(critical).toMatchObject({
      availableBytes: "0",
      policy: { maxBytes: 1, warningPercent: 80 },
      status: "CRITICAL",
    });
    expect(critical.usedPercent).toBe(100);
    expect(BigInt(critical.usedBytes)).toBeGreaterThan(1n);
  });

  async function expectCounts(expected: {
    actions: number;
    approvals: number;
    inbox: number;
    outbox: number;
  }): Promise<void> {
    expect(await count("actions")).toBe(expected.actions);
    expect(await count("approvals")).toBe(expected.approvals);
    expect(await count("consumer_inbox")).toBe(expected.inbox);
    expect(await count("outbox")).toBe(expected.outbox);
  }

  async function count(table: "actions" | "approvals" | "consumer_inbox" | "outbox") {
    const result = await pool.query<{ count: string }>(`SELECT count(*) FROM ${table}`);
    return Number(result.rows[0]?.count ?? "0");
  }

  async function ids(table: "actions" | "executions"): Promise<readonly string[]> {
    const result = await pool.query<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`);
    return result.rows.map((row) => row.id);
  }
});

function agent(id: string) {
  return {
    capabilities: ACTOR_CAPABILITY_PROFILES.agent,
    client: "test",
    id,
    principal: id,
    type: "agent" as const,
  };
}
