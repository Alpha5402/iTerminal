import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresObservationRepository } from "./postgres-observation-repository.js";
import { PostgresRuntimeRepository } from "./postgres-runtime-repository.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("PostgresObservationRepository", () => {
  const databaseTarget = databaseUrl ?? "postgresql://localhost/iterminal_test";
  const runtime = new PostgresRuntimeRepository(databaseTarget);
  const observation = new PostgresObservationRepository(databaseTarget);
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M3 tests refuse to mutate any database except iterminal_test");
    }
    await runtime.migrate();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox, artifacts RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    await observation.close();
    await runtime.close();
    await pool.end();
  });

  it("returns bounded timeline pages with scoped cursors and actor attribution", async () => {
    const session = await createSession(runtime);
    const acceptedAt = new Date("2026-08-30T00:00:00.000Z");
    const firstOutputAt = new Date("2026-08-30T00:00:01.000Z");
    const secondOutputAt = new Date("2026-08-30T00:00:02.000Z");
    const accepted = await runtime.acceptExecute({
      acceptedAt,
      actionId: `act_${randomUUID()}`,
      actor: {
        client: "mcp",
        id: "agent-observer",
        principal: "local-agent",
        type: "agent",
      },
      command: "build",
      eventId: `evt_${randomUUID()}`,
      executionId: `exe_${randomUUID()}`,
      generation: 1,
      idempotencyKey: "observe-execute",
      outboxId: `out_${randomUUID()}`,
      requestHash: "observe-hash",
      sessionId: session,
    });
    await observation.appendOutput({
      createdAt: firstOutputAt,
      data: "INFO compile started",
      executionId: accepted.executionId,
      generation: 1,
      sessionId: session,
    });
    await observation.appendOutput({
      createdAt: secondOutputAt,
      data: "FAIL compile stopped",
      executionId: accepted.executionId,
      generation: 1,
      sessionId: session,
    });

    const first = await observation.queryEvents({ generation: 1, limit: 2, sessionId: session });
    expect(first.events).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(first.events[0]?.actor).toMatchObject({ id: "agent-observer", type: "agent" });
    const cursor = first.nextCursor;
    if (cursor === undefined) {
      throw new Error("Expected a cursor for the truncated first page");
    }
    const second = await observation.queryEvents({
      cursor,
      generation: 1,
      limit: 2,
      sessionId: session,
    });
    expect(second.events).toHaveLength(1);
    await expect(
      observation.queryEvents({
        cursor,
        generation: 2,
        sessionId: session,
      }),
    ).rejects.toMatchObject({ code: "RESYNC_REQUIRED" });

    const event = await observation.getEvent(first.events[0]?.id ?? "missing");
    expect(event?.actionId).toBeDefined();
    const filtered = await observation.queryEvents({
      after: 1,
      before: 4,
      executionId: accepted.executionId,
      from: firstOutputAt,
      generation: 1,
      sessionId: session,
      to: secondOutputAt,
      types: ["terminal.pty_output"],
    });
    expect(filtered.events.map((candidate) => candidate.sequence)).toEqual([2, 3]);
    const execution = await observation.getExecution(accepted.executionId);
    expect(execution).toMatchObject({
      eventRange: { first: 1, last: 3 },
      outputByteCount: 40,
      status: "DISPATCHING",
    });
  });

  it("moves large output to an artifact and bounds every read", async () => {
    const session = await createSession(runtime);
    const content = `HEAD-${"x".repeat(100_000)}-TAIL`;
    const written = await observation.appendOutput({
      createdAt: new Date(),
      data: content,
      generation: 1,
      inlineThresholdBytes: 1024,
      sessionId: session,
    });
    expect(written.artifactRef).toBeDefined();
    expect(written.byteCount).toBe(Buffer.byteLength(content));
    expect(written.tailPreview.endsWith("-TAIL")).toBe(true);
    const first = await observation.readArtifact(written.artifactRef ?? "missing", 0, 1_000_000);
    expect(first).toMatchObject({ byteSize: Buffer.byteLength(content), truncated: true });
    expect(Buffer.from(String(first?.contentBase64), "base64")).toHaveLength(64 * 1024);
    const eventPage = await observation.queryEvents({ generation: 1, sessionId: session });
    expect(eventPage.events[0]?.payload).not.toHaveProperty("data");
    expect(eventPage.events[0]?.payload).toMatchObject({ artifactRef: written.artifactRef });
    await expect(
      observation.readArtifact(written.artifactRef ?? "missing", -1),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      observation.appendOutput({
        createdAt: new Date(),
        data: "invalid threshold",
        generation: 1,
        inlineThresholdBytes: -1,
        sessionId: session,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("finds sparse failures in 100k lines without returning the full stream", async () => {
    const session = await createSession(runtime);
    const startedAt = performance.now();
    await seedOutputLines(pool, {
      batchId: `evt_bulk_${randomUUID()}`,
      failEvery: 25_000,
      generation: 1,
      lineCount: 100_000,
      sessionId: session,
    });
    const ingestMilliseconds = performance.now() - startedAt;
    const searchStartedAt = performance.now();
    const matches = await observation.searchEvents({
      contextAfter: 1,
      contextBefore: 1,
      generation: 1,
      keyword: "FAIL",
      limit: 10,
      sessionId: session,
    });
    const searchMilliseconds = performance.now() - searchStartedAt;
    expect(matches).toHaveLength(4);
    expect(matches.every((match) => match.context.length <= 3)).toBe(true);
    expect(matches.map((match) => match.event.sequence)).toEqual([25_000, 50_000, 75_000, 100_000]);

    const slowConsumer = await observation.queryEvents({
      generation: 1,
      limit: 50,
      sessionId: session,
    });
    expect(slowConsumer.events).toHaveLength(50);
    expect(slowConsumer.truncated).toBe(true);
    expect(JSON.stringify(slowConsumer).length).toBeLessThan(50_000);
    expect(ingestMilliseconds).toBeLessThan(15_000);
    expect(searchMilliseconds).toBeLessThan(5_000);
    await expect(
      observation.searchEvents({ generation: 1, keyword: "   ", sessionId: session }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  }, 30_000);

  it("requires resync when retention has removed the cursor's next event", async () => {
    const session = await createSession(runtime);
    await seedOutputLines(pool, {
      batchId: `evt_gap_${randomUUID()}`,
      failEvery: 100,
      generation: 1,
      lineCount: 10,
      sessionId: session,
    });
    await pool.query("DELETE FROM session_events WHERE session_id = $1 AND event_sequence <= 5", [
      session,
    ]);
    await expect(
      observation.queryEvents({ after: 1, generation: 1, sessionId: session }),
    ).rejects.toMatchObject({ code: "RESYNC_REQUIRED" });
  });
});

async function createSession(repository: PostgresRuntimeRepository): Promise<string> {
  const sessionId = `ses_${randomUUID()}`;
  await repository.createReadySession({
    createdAt: new Date(),
    generation: 1,
    id: sessionId,
    integrationVersion: "m3-test-v1",
    ownerId: `owner_${randomUUID()}`,
    shell: "zsh",
    workspaceRoot: "/tmp/iterminal-test",
  });
  return sessionId;
}

async function seedOutputLines(
  pool: Pool,
  input: {
    readonly sessionId: string;
    readonly generation: number;
    readonly lineCount: number;
    readonly failEvery: number;
    readonly batchId: string;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const allocated = await client.query<{ next_event_sequence: string }>(
      `UPDATE session_generations
          SET next_event_sequence = next_event_sequence + $3
        WHERE session_id = $1 AND generation = $2
      RETURNING next_event_sequence`,
      [input.sessionId, input.generation, input.lineCount],
    );
    const endSequence = Number.parseInt(allocated.rows[0]?.next_event_sequence ?? "0", 10);
    const startSequence = endSequence - input.lineCount + 1;
    await client.query(
      `INSERT INTO session_events
        (id, session_id, session_generation, event_sequence, event_type,
         payload, created_at, search_text)
       SELECT $1 || '-' || n::text, $2, $3, $4 + n - 1, 'terminal.pty_output',
              jsonb_build_object('byteCount', octet_length(line), 'tailPreview', line),
              now(), line
         FROM (
           SELECT n,
                  CASE WHEN n % $5 = 0
                       THEN 'FAIL sparse-error-' || n::text
                       ELSE 'INFO ordinary-line-' || n::text END AS line
             FROM generate_series(1, $6) AS n
         ) generated`,
      [
        input.batchId,
        input.sessionId,
        input.generation,
        startSequence,
        input.failEvery,
        input.lineCount,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
