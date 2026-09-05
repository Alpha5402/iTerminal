import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
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
    await pool.query(
      `UPDATE artifact_storage_policies
          SET max_bytes = 1073741824,
              max_artifact_bytes = 16777216,
              retention_milliseconds = 604800000,
              cleanup_batch_size = 1000,
              updated_at = now()
        WHERE scope = 'default'`,
    );
    await pool.query(
      `UPDATE artifact_storage_usage
          SET artifact_count = 0, byte_size = 0, updated_at = now()
        WHERE scope = 'default'`,
    );
    await pool.query(
      `UPDATE retention_policies
          SET max_age_days = 7, max_events_per_generation = 100000,
              cleanup_batch_size = 10000, updated_at = now()
        WHERE scope = 'default'`,
    );
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
        capabilities: ACTOR_CAPABILITY_PROFILES.agent,
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

  it("reads exact scoped byte ranges without changing the Event shape", async () => {
    const session = await createSession(runtime);
    const otherSession = await createSession(runtime);
    const content = `${"a".repeat(8_190)}中文🙂${"x".repeat(100_000)}-TAIL`;
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
    const artifactId = written.artifactRef ?? "missing";
    const first = await observation.readArtifact({
      artifactId,
      generation: 1,
      offsetBytes: 0,
      sessionId: session,
    });
    expect(first).toMatchObject({
      eof: false,
      nextOffset: 8 * 1024,
      offsetBytes: 0,
      returnedBytes: 8 * 1024,
      totalBytes: Buffer.byteLength(content),
    });
    expect(first).not.toHaveProperty("sha256");
    if (first.kind !== "found") throw new Error("Expected retained Artifact content");
    expect(Buffer.from(first.contentBase64, "base64")).toHaveLength(8 * 1024);
    const maximum = await observation.readArtifact({
      artifactId,
      generation: 1,
      maxBytes: 64 * 1024,
      offsetBytes: 0,
      sessionId: session,
    });
    expect(maximum).toMatchObject({ kind: "found", returnedBytes: 64 * 1024 });
    const eventPage = await observation.queryEvents({ generation: 1, sessionId: session });
    expect(eventPage.events[0]?.payload).not.toHaveProperty("data");
    expect(eventPage.events[0]?.payload).toMatchObject({ artifactRef: written.artifactRef });

    const crossSession = await observation.readArtifact({
      artifactId,
      generation: 1,
      offsetBytes: 0,
      sessionId: otherSession,
    });
    const missing = await observation.readArtifact({
      artifactId: "art_missing",
      generation: 1,
      offsetBytes: 0,
      sessionId: otherSession,
    });
    expect(crossSession).toMatchObject({ kind: "not_found", sessionId: otherSession });
    expect({ ...crossSession, artifactId: "same" }).toEqual({ ...missing, artifactId: "same" });

    await expect(
      observation.readArtifact({
        artifactId,
        generation: 1,
        maxBytes: 64 * 1024 + 1,
        offsetBytes: 0,
        sessionId: session,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      observation.readArtifact({
        artifactId,
        generation: 1,
        offsetBytes: Number.MAX_SAFE_INTEGER,
        sessionId: session,
      }),
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

  it("losslessly reassembles 7 KiB and 1 MiB UTF-8 fixtures and classifies expiry", async () => {
    const session = await createSession(runtime);
    const sevenKiB =
      "七🙂".repeat(512) + "x".repeat(7 * 1024 - Buffer.byteLength("七🙂".repeat(512)));
    const oneMiB =
      "a".repeat(8_190) + "中文🙂" + "b".repeat(1024 * 1024 - 8_190 - Buffer.byteLength("中文🙂"));

    for (const [label, content] of [
      ["seven-kib", sevenKiB],
      ["one-mib", oneMiB],
    ] as const) {
      expect(Buffer.byteLength(content)).toBe(label === "seven-kib" ? 7 * 1024 : 1024 * 1024);
      const written = await observation.appendOutput({
        createdAt: new Date(),
        data: content,
        generation: 1,
        inlineThresholdBytes: 1,
        sessionId: session,
      });
      const artifactId = written.artifactRef ?? "missing";
      const chunks: Buffer[] = [];
      let offsetBytes = 0;
      for (;;) {
        const page = await observation.readArtifact({
          artifactId,
          generation: 1,
          ...(label === "seven-kib" ? {} : { maxBytes: 8 * 1024 }),
          offsetBytes,
          sessionId: session,
        });
        if (page.kind !== "found") throw new Error(`Expected ${label} Artifact page`);
        chunks.push(Buffer.from(page.contentBase64, "base64"));
        expect(page.nextOffset).toBe(page.offsetBytes + page.returnedBytes);
        offsetBytes = page.nextOffset;
        if (page.eof) break;
      }
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(content, "utf8"));

      const eof = await observation.readArtifact({
        artifactId,
        generation: 1,
        offsetBytes: Buffer.byteLength(content),
        sessionId: session,
      });
      expect(eof).toMatchObject({ eof: true, kind: "found", returnedBytes: 0 });

      if (label === "seven-kib") {
        await pool.query(
          "UPDATE artifacts SET expires_at = now() - interval '1 second' WHERE id = $1",
          [artifactId],
        );
        await expect(
          observation.readArtifact({
            artifactId,
            generation: 1,
            offsetBytes: 0,
            sessionId: session,
          }),
        ).resolves.toMatchObject({ kind: "expired" });
      }
    }
  });

  it("serializes concurrent Artifact admission, commits cleanup, and keeps exact usage", async () => {
    const session = await createSession(runtime);
    await pool.query(
      `UPDATE artifact_storage_policies
          SET max_bytes = 9000, max_artifact_bytes = 7000,
              retention_milliseconds = 60000, cleanup_batch_size = 2,
              updated_at = now()
        WHERE scope = 'default'`,
    );
    const content = "x".repeat(6000);
    const concurrent = await Promise.allSettled([
      observation.appendOutput({
        createdAt: new Date(),
        data: content,
        generation: 1,
        inlineThresholdBytes: 1,
        sessionId: session,
      }),
      observation.appendOutput({
        createdAt: new Date(),
        data: content,
        generation: 1,
        inlineThresholdBytes: 1,
        sessionId: session,
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = concurrent.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: {
        code: "BACKPRESSURE",
        details: {
          component: "artifact_storage",
          currentBytes: 6000,
          maxArtifactBytes: 7000,
          maxBytes: 9000,
          phase: "artifact_admission",
          requestedBytes: 6000,
        },
        retryable: true,
      },
      status: "rejected",
    });
    expect(await observation.inspectArtifactStorage()).toMatchObject({
      usage: { artifactCount: 1, byteSize: 6000 },
    });
    expect(
      (await observation.queryEvents({ generation: 1, sessionId: session })).events,
    ).toHaveLength(1);

    await expect(
      observation.appendOutput({
        createdAt: new Date(),
        data: "y".repeat(7001),
        generation: 1,
        inlineThresholdBytes: 1,
        sessionId: session,
      }),
    ).rejects.toMatchObject({
      code: "BACKPRESSURE",
      details: { currentBytes: 6000, maxArtifactBytes: 7000, requestedBytes: 7001 },
    });

    await expect(
      pool.query(
        `INSERT INTO artifacts
          (id, session_id, session_generation, kind, content, content_type,
           byte_size, sha256, created_at, expires_at)
         VALUES ($1, $2, 1, 'pty_output', $3, 'application/octet-stream',
                 $4, $5, now(), now() + interval '1 day')`,
        [`art_${randomUUID()}`, session, Buffer.from(content), content.length, "0".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "artifacts_storage_budget" });

    await pool.query("UPDATE artifacts SET expires_at = now() - interval '1 second'");
    await expect(
      observation.appendOutput({
        createdAt: new Date(),
        data: "z".repeat(7001),
        generation: 1,
        inlineThresholdBytes: 1,
        sessionId: session,
      }),
    ).rejects.toMatchObject({ code: "BACKPRESSURE" });
    expect(await observation.inspectArtifactStorage()).toMatchObject({
      usage: { artifactCount: 0, byteSize: 0 },
    });

    await observation.appendOutput({
      createdAt: new Date(),
      data: content,
      generation: 1,
      inlineThresholdBytes: 1,
      sessionId: session,
    });
    expect(await observation.inspectArtifactStorage()).toMatchObject({
      usage: { artifactCount: 1, byteSize: 6000 },
    });
    await pool.query("DELETE FROM sessions WHERE id = $1", [session]);
    expect(await observation.inspectArtifactStorage()).toMatchObject({
      usage: { artifactCount: 0, byteSize: 0 },
    });
  });

  it("deletes only one configured expired-Artifact batch per maintenance run", async () => {
    const session = await createSession(runtime);
    await pool.query(
      `UPDATE artifact_storage_policies
          SET max_bytes = 30000, max_artifact_bytes = 10000,
              retention_milliseconds = 60000, cleanup_batch_size = 1,
              updated_at = now()
        WHERE scope = 'default'`,
    );
    for (const data of ["a".repeat(5000), "b".repeat(5000)]) {
      await observation.appendOutput({
        createdAt: new Date(),
        data,
        generation: 1,
        inlineThresholdBytes: 1,
        sessionId: session,
      });
    }
    await pool.query("UPDATE artifacts SET expires_at = now() - interval '1 second'");
    const first = await observation.maintainArtifactStorage();
    expect(first).toMatchObject({
      deletedArtifacts: 1,
      deletedBytes: 5000,
      usage: { artifactCount: 1, byteSize: 5000 },
    });
    const second = await observation.maintainArtifactStorage();
    expect(second).toMatchObject({
      deletedArtifacts: 1,
      deletedBytes: 5000,
      usage: { artifactCount: 0, byteSize: 0 },
    });
    expect((await observation.maintainArtifactStorage()).deletedArtifacts).toBe(0);
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

  it("masks an older fragment after an unsupported direct middle deletion", async () => {
    const session = await createSession(runtime);
    for (let index = 1; index <= 6; index += 1) {
      await observation.appendOutput({
        createdAt: new Date(),
        data: `direct-delete-${index.toString()}`,
        generation: 1,
        sessionId: session,
      });
    }
    await pool.query(
      `DELETE FROM session_events
        WHERE session_id = $1 AND session_generation = 1 AND event_sequence = 4`,
      [session],
    );

    await expect(
      observation.queryEvents({ after: 3, generation: 1, sessionId: session }),
    ).rejects.toMatchObject({
      code: "RESYNC_REQUIRED",
      details: { minimumAvailableSequence: 5 },
    });
    expect(
      (await observation.queryEvents({ generation: 1, limit: 10, sessionId: session })).events.map(
        (event) => event.sequence,
      ),
    ).toEqual([5, 6]);
    expect((await observation.maintainEventRetention()).deletedEvents).toBe(3);
    const physical = await pool.query<{ event_sequence: string }>(
      `SELECT event_sequence::text
         FROM session_events
        WHERE session_id = $1 AND session_generation = 1
        ORDER BY event_sequence`,
      [session],
    );
    expect(physical.rows.map((row) => Number.parseInt(row.event_sequence, 10))).toEqual([5, 6]);
  });

  it("deletes one bounded Event prefix and advances a cursor-safe watermark", async () => {
    const session = await createSession(runtime);
    await pool.query(
      `UPDATE retention_policies
          SET max_age_days = 7, max_events_per_generation = 5,
              cleanup_batch_size = 2, updated_at = now()
        WHERE scope = 'default'`,
    );
    for (let index = 1; index <= 10; index += 1) {
      await observation.appendOutput({
        createdAt: new Date(),
        data: `retention-${index.toString()}`,
        generation: 1,
        sessionId: session,
      });
    }

    expect((await observation.maintainEventRetention()).deletedEvents).toBe(2);
    await expect(
      observation.queryEvents({ after: 1, generation: 1, sessionId: session }),
    ).rejects.toMatchObject({
      code: "RESYNC_REQUIRED",
      details: { minimumAvailableSequence: 3 },
    });
    expect((await observation.maintainEventRetention()).deletedEvents).toBe(2);
    expect((await observation.maintainEventRetention()).deletedEvents).toBe(1);
    expect((await observation.maintainEventRetention()).deletedEvents).toBe(0);

    const fresh = await observation.queryEvents({ generation: 1, limit: 10, sessionId: session });
    expect(fresh.events.map((event) => event.sequence)).toEqual([6, 7, 8, 9, 10]);
    const watermark = await pool.query<{
      deleted_events: string;
      deleted_through_sequence: string;
    }>(
      `SELECT deleted_through_sequence::text, deleted_events::text
         FROM event_retention_watermarks
        WHERE session_id = $1 AND session_generation = 1`,
      [session],
    );
    expect(watermark.rows[0]).toEqual({
      deleted_events: "5",
      deleted_through_sequence: "5",
    });
  });

  it("keeps Event age cleanup contiguous and preserves the latest anchor", async () => {
    const session = await createSession(runtime);
    const now = new Date("2026-08-31T00:00:00.000Z");
    const old = new Date("2026-08-01T00:00:00.000Z");
    const fresh = new Date("2026-08-30T00:00:00.000Z");
    await pool.query(
      `UPDATE retention_policies
          SET max_age_days = 7, max_events_per_generation = 100,
              cleanup_batch_size = 10, updated_at = now()
        WHERE scope = 'default'`,
    );
    for (const [index, createdAt] of [old, old, fresh, old, old].entries()) {
      await observation.appendOutput({
        createdAt,
        data: `age-${index.toString()}`,
        generation: 1,
        sessionId: session,
      });
    }
    expect((await observation.maintainEventRetention(now)).deletedEvents).toBe(2);
    const retained = await observation.queryEvents({
      generation: 1,
      limit: 10,
      sessionId: session,
    });
    expect(retained.events.map((event) => event.sequence)).toEqual([3, 4, 5]);

    const allOldSession = await createSession(runtime);
    for (let index = 0; index < 3; index += 1) {
      await observation.appendOutput({
        createdAt: old,
        data: `all-old-${index.toString()}`,
        generation: 1,
        sessionId: allOldSession,
      });
    }
    expect((await observation.maintainEventRetention(now)).deletedEvents).toBe(2);
    const anchor = await observation.queryEvents({
      generation: 1,
      limit: 10,
      sessionId: allOldSession,
    });
    expect(anchor.events.map((event) => event.sequence)).toEqual([3]);
  });

  it("pages exact durable Execution bytes without duplicate boundaries", async () => {
    const sessionId = await createSession(runtime);
    const executionId = await createAcceptedExecution(runtime, sessionId, "output-pages");
    const expected = Buffer.from(
      `${"a".repeat(4_096)}${"鲸".repeat(1_365)}x${"b".repeat(4_096)}`,
      "utf8",
    );
    for (const data of ["a".repeat(4_096), `${"鲸".repeat(1_365)}x`, "b".repeat(4_096)]) {
      await observation.appendOutput({
        createdAt: new Date(),
        data,
        executionId,
        generation: 1,
        sessionId,
      });
    }

    const first = await observation.readExecutionOutput({
      executionId,
      generation: 1,
      maxBytes: 4_097,
      sessionId,
    });
    expect(first).toMatchObject({
      executionState: "DISPATCHING",
      gap: null,
      hasMore: true,
      persistenceLag: "possible",
      stream: "pty",
    });
    const pages = [first];
    while (pages.at(-1)?.hasMore === true) {
      const cursor = pages.at(-1)?.nextCursor;
      if (cursor === undefined) throw new Error("Expected a cursor while durable bytes remain");
      pages.push(
        await observation.readExecutionOutput({
          cursor,
          executionId,
          generation: 1,
          maxBytes: 4_097,
          sessionId,
        }),
      );
    }
    expect(Buffer.concat(pages.map(decodeOutput))).toEqual(expected);
    const second = pages[1];
    if (second === undefined) throw new Error("Expected a second output page");

    const reopened = new PostgresObservationRepository(databaseTarget);
    try {
      if (first.nextCursor === undefined) throw new Error("Expected first output cursor");
      const replay = await reopened.readExecutionOutput({
        cursor: first.nextCursor,
        executionId,
        generation: 1,
        maxBytes: 4_097,
        sessionId,
      });
      expect(decodeOutput(replay)).toEqual(decodeOutput(second));
      expect(replay.nextCursor).toBe(second.nextCursor);
    } finally {
      await reopened.close();
    }
  });

  it("reports hasMore=false when the byte budget ends at the final Event boundary", async () => {
    const sessionId = await createSession(runtime);
    const executionId = await createAcceptedExecution(runtime, sessionId, "exact-boundary");
    await observation.appendOutput({
      createdAt: new Date(),
      data: "x".repeat(4_096),
      executionId,
      generation: 1,
      sessionId,
    });
    await observation.appendOutput({
      createdAt: new Date(),
      data: "y".repeat(4_096),
      executionId,
      generation: 1,
      sessionId,
    });

    const result = await observation.readExecutionOutput({
      executionId,
      generation: 1,
      maxBytes: 8_192,
      sessionId,
    });
    expect(decodeOutput(result)).toHaveLength(8_192);
    expect(result.hasMore).toBe(false);
  });

  it("uses a bounded 65th Event probe without hiding additional tiny Events", async () => {
    const sessionId = await createSession(runtime);
    const executionId = await createAcceptedExecution(runtime, sessionId, "event-scan-probe");
    for (let index = 0; index < 66; index += 1) {
      await observation.appendOutput({
        createdAt: new Date(),
        data: String.fromCharCode(65 + (index % 26)),
        executionId,
        generation: 1,
        sessionId,
      });
    }

    const first = await observation.readExecutionOutput({
      executionId,
      generation: 1,
      maxBytes: 64 * 1024,
      sessionId,
    });
    expect(decodeOutput(first)).toHaveLength(64);
    expect(first.hasMore).toBe(true);
    if (first.nextCursor === undefined) throw new Error("Expected scan continuation cursor");
    const second = await observation.readExecutionOutput({
      cursor: first.nextCursor,
      executionId,
      generation: 1,
      maxBytes: 64 * 1024,
      sessionId,
    });
    expect(decodeOutput(second)).toHaveLength(2);
    expect(second.hasMore).toBe(false);
  });

  it("checks exact Execution scope before parsing an opaque cursor", async () => {
    const sessionId = await createSession(runtime);
    const otherSessionId = await createSession(runtime);
    const executionId = await createAcceptedExecution(runtime, sessionId, "cursor-scope");
    await observation.appendOutput({
      createdAt: new Date(),
      data: "scope",
      executionId,
      generation: 1,
      sessionId,
    });

    await expect(
      observation.readExecutionOutput({
        cursor: "not-a-valid-cursor",
        executionId,
        generation: 1,
        sessionId: otherSessionId,
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
    await expect(
      observation.readExecutionOutput({
        cursor: "not-a-valid-cursor",
        executionId,
        generation: 1,
        sessionId,
      }),
    ).rejects.toMatchObject({ code: "RESYNC_REQUIRED" });
  });

  it("rejects canonical future, wrong-anchor, offset, and foreign-scope cursors", async () => {
    const sessionId = await createSession(runtime);
    const otherSessionId = await createSession(runtime);
    const executionId = await createAcceptedExecution(runtime, sessionId, "canonical-forgery");
    const output = await observation.appendOutput({
      createdAt: new Date(),
      data: "cursor-anchor",
      executionId,
      generation: 1,
      sessionId,
    });
    const first = await observation.readExecutionOutput({
      executionId,
      generation: 1,
      maxBytes: 1,
      sessionId,
    });
    if (first.nextCursor === undefined) throw new Error("Expected a durable output cursor");

    const foreignCursor = mutateOutputCursor(first.nextCursor, { sessionId: otherSessionId });
    const forged = [
      mutateOutputCursor(first.nextCursor, { eventSequence: Number.MAX_SAFE_INTEGER }),
      mutateOutputCursor(first.nextCursor, { eventSequence: output.eventSequence - 1 }),
      mutateOutputCursor(first.nextCursor, { eventOffset: output.byteCount + 1 }),
      foreignCursor,
    ];
    for (const cursor of forged) {
      await expect(
        observation.readExecutionOutput({
          cursor,
          executionId,
          generation: 1,
          sessionId,
        }),
      ).rejects.toMatchObject({ code: "RESYNC_REQUIRED" });
    }

    await expect(
      observation.readExecutionOutput({
        cursor: foreignCursor,
        executionId,
        generation: 1,
        sessionId: otherSessionId,
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
  });

  it("stops at a missing Artifact and requires its explicit resume cursor", async () => {
    const sessionId = await createSession(runtime);
    const executionId = await createAcceptedExecution(runtime, sessionId, "artifact-gap");
    const missing = await observation.appendOutput({
      createdAt: new Date(),
      data: "m".repeat(8_000),
      executionId,
      generation: 1,
      inlineThresholdBytes: 1,
      sessionId,
    });
    await observation.appendOutput({
      createdAt: new Date(),
      data: "after-gap",
      executionId,
      generation: 1,
      sessionId,
    });
    await pool.query("DELETE FROM artifacts WHERE id = $1", [missing.artifactRef]);

    const blocked = await observation.readExecutionOutput({
      executionId,
      generation: 1,
      sessionId,
    });
    expect(blocked).toMatchObject({
      chunks: [],
      gap: { eventSequence: missing.eventSequence, kind: "artifact_missing" },
      hasMore: false,
    });
    expect(blocked.nextCursor).toBeUndefined();
    if (blocked.gap?.kind !== "artifact_missing") throw new Error("Expected missing Artifact gap");

    const resumed = await observation.readExecutionOutput({
      cursor: blocked.gap.resumeCursor,
      executionId,
      generation: 1,
      sessionId,
    });
    expect(decodeOutput(resumed).toString("utf8")).toBe("after-gap");
    expect(resumed.gap).toBeNull();
  });

  it("classifies an expired output Artifact separately from a missing Artifact", async () => {
    const sessionId = await createSession(runtime);
    const executionId = await createAcceptedExecution(runtime, sessionId, "expired-artifact-gap");
    const expired = await observation.appendOutput({
      createdAt: new Date(),
      data: "e".repeat(8_000),
      executionId,
      generation: 1,
      inlineThresholdBytes: 1,
      sessionId,
    });
    await pool.query(
      "UPDATE artifacts SET expires_at = now() - interval '1 second' WHERE id = $1",
      [expired.artifactRef],
    );

    const blocked = await observation.readExecutionOutput({
      executionId,
      generation: 1,
      sessionId,
    });
    expect(blocked.gap).toMatchObject({
      eventSequence: expired.eventSequence,
      kind: "artifact_expired",
    });
    expect(blocked.chunks).toEqual([]);
  });

  it("reports a conservative Event retention gap instead of silently skipping history", async () => {
    const sessionId = await createSession(runtime);
    const executionId = await createAcceptedExecution(runtime, sessionId, "retention-gap");
    const outputs = [];
    for (const data of ["gone-one", "gone-two", "retained-tail"]) {
      outputs.push(
        await observation.appendOutput({
          createdAt: new Date(),
          data,
          executionId,
          generation: 1,
          sessionId,
        }),
      );
    }
    const deletedThrough = outputs[1]?.eventSequence;
    const retainedSequence = outputs[2]?.eventSequence;
    if (deletedThrough === undefined || retainedSequence === undefined) {
      throw new Error("Expected output Event sequences");
    }
    const stale = await observation.readExecutionOutput({
      executionId,
      generation: 1,
      maxBytes: 1,
      sessionId,
    });
    if (stale.nextCursor === undefined) throw new Error("Expected a pre-retention cursor");
    await pool.query(
      `DELETE FROM session_events
        WHERE session_id = $1 AND session_generation = 1 AND event_sequence <= $2`,
      [sessionId, deletedThrough],
    );

    await expect(
      observation.readExecutionOutput({
        cursor: stale.nextCursor,
        executionId,
        generation: 1,
        sessionId,
      }),
    ).rejects.toMatchObject({
      code: "RESYNC_REQUIRED",
      details: { minimumAvailableSequence: retainedSequence },
    });

    const retained = await observation.readExecutionOutput({
      executionId,
      generation: 1,
      sessionId,
    });
    expect(retained.gap).toMatchObject({
      kind: "event_retention",
      minimumAvailableSequence: retainedSequence,
    });
    expect(decodeOutput(retained).toString("utf8")).toBe("retained-tail");
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

async function createAcceptedExecution(
  repository: PostgresRuntimeRepository,
  sessionId: string,
  idempotencyKey: string,
): Promise<string> {
  const accepted = await repository.acceptExecute({
    acceptedAt: new Date(),
    actionId: `act_${randomUUID()}`,
    actor: {
      capabilities: ACTOR_CAPABILITY_PROFILES.agent,
      client: "execution-output-test",
      id: `agent_${randomUUID()}`,
      principal: "execution-output-test",
      type: "agent",
    },
    command: "printf output",
    eventId: `evt_${randomUUID()}`,
    executionId: `exe_${randomUUID()}`,
    generation: 1,
    idempotencyKey,
    outboxId: `out_${randomUUID()}`,
    requestHash: `hash-${idempotencyKey}`,
    sessionId,
  });
  return accepted.executionId;
}

function decodeOutput(result: {
  readonly chunks: readonly Readonly<{ readonly contentBase64: string }>[];
}): Buffer {
  return Buffer.concat(result.chunks.map((chunk) => Buffer.from(chunk.contentBase64, "base64")));
}

function mutateOutputCursor(cursor: string, changes: Readonly<Record<string, unknown>>): string {
  const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  return Buffer.from(JSON.stringify({ ...payload, ...changes }), "utf8").toString("base64url");
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
