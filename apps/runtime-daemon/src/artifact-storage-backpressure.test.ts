import { ACTOR_CAPABILITY_PROFILES } from "@iterminal/domain";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionFence } from "@iterminal/application";
import type { Actor } from "@iterminal/domain";
import { PostgresRuntimeDurability } from "@iterminal/persistence-postgres";
import { UnixRuntimeClient } from "@iterminal/runtime-rpc";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startRuntimeDaemon, type RuntimeDaemonHandle } from "./server.js";

const databaseUrl = process.env.ITERM_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const actor: Actor = {
  capabilities: ACTOR_CAPABILITY_PROFILES.agent,
  client: "m10-artifact-agent",
  id: "agent-m10-artifact",
  principal: "local-m10-artifact-agent",
  type: "agent",
};

describeDatabase("M10.5/M10.6 durable Artifact storage and PTY output coalescing", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const fixtures: string[] = [];
  let daemon: RuntimeDaemonHandle | undefined;

  beforeAll(async () => {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "iterminal_test") {
      throw new Error("M10 Artifact tests refuse to mutate any database except iterminal_test");
    }
    const migrator = new PostgresRuntimeDurability(databaseUrl ?? "");
    await migrator.migrate();
    await migrator.close();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE sessions, actors, outbox, artifacts RESTART IDENTITY CASCADE");
    await pool.query(
      `UPDATE artifact_storage_policies
          SET max_bytes = 8192, max_artifact_bytes = 1024,
              retention_milliseconds = 60000, cleanup_batch_size = 10,
              updated_at = now()
        WHERE scope = 'default'`,
    );
    await pool.query(
      `UPDATE artifact_storage_usage
          SET artifact_count = 0, byte_size = 0, updated_at = now()
        WHERE scope = 'default'`,
    );
  });

  afterEach(async () => {
    await daemon?.close().catch(() => undefined);
    daemon = undefined;
    for (const fixture of fixtures.splice(0)) {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  afterAll(async () => pool.end());

  it("persists BROKEN/UNKNOWN and releases the lease instead of leaving an output gap", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m10-artifact-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-m10-artifact",
      socketPath: join(root, "runtime.sock"),
    });
    await daemon.waitUntilReady();
    const rpc = new UnixRuntimeClient(daemon.socketPath);
    const capabilities = await rpc.getRuntimeCapabilities();
    expect(capabilities.features).toContain("artifact.read.v1");
    const session = await rpc.createSession({
      idempotencyKey: "m10-artifact-session",
      shell: "zsh",
      workspaceRoot: workspace,
    });
    const started = await rpc.startExecute({
      actor,
      command: "sleep 30",
      idempotencyKey: "m10-artifact-large-output",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await waitUntil(async () => {
      const result = await pool.query<{ status: string }>(
        "SELECT status FROM executions WHERE id = $1",
        [started.execution.id],
      );
      return result.rows[0]?.status === "RUNNING";
    });

    const lease = await pool.query<{
      fencing_token: string;
      owner_id: string;
      owner_instance_id: string;
      owner_registry_epoch: string;
      session_generation: number;
      session_id: string;
    }>(
      `SELECT session_id, session_generation, owner_id, owner_instance_id,
              owner_registry_epoch::text, fencing_token::text
         FROM session_leases
        WHERE session_id = $1 AND session_generation = $2 AND released_at IS NULL`,
      [session.id, session.generation],
    );
    const leaseRow = lease.rows[0];
    if (leaseRow === undefined) throw new Error("Expected the live Session lease");
    const fence: SessionFence = {
      epoch: Number.parseInt(leaseRow.owner_registry_epoch, 10),
      fencingToken: leaseRow.fencing_token,
      generation: leaseRow.session_generation,
      instanceId: leaseRow.owner_instance_id,
      ownerId: leaseRow.owner_id,
      sessionId: leaseRow.session_id,
    };
    const sentinel = "M10_ARTIFACT_REJECTED_SENTINEL_";
    const rejectedOutput = sentinel.repeat(200);
    const durability = new PostgresRuntimeDurability(databaseUrl ?? "", { poolMax: 1 });
    try {
      await expect(
        durability.appendEvent(fence, {
          executionId: started.execution.id,
          id: "evt_m10_artifact_rejected_output",
          observedAt: new Date().toISOString(),
          payload: {
            byteLength: Buffer.byteLength(rejectedOutput),
            data: rejectedOutput,
            screenVersion: 1,
          },
          sessionGeneration: session.generation,
          sessionId: session.id,
          type: "terminal.pty_output",
        }),
      ).rejects.toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
        details: {
          component: "artifact_storage",
          durabilityScope: "session",
          phase: "durable_output_admission",
        },
        retryable: false,
      });
    } finally {
      await durability.close();
    }

    const durable = await pool.query<{
      action_status: string;
      artifact_count: string;
      broken_events: string;
      execution_status: string;
      lease_released: boolean;
      session_status: string;
      usage_bytes: string;
    }>(
      `SELECT session.status AS session_status,
              action.status AS action_status,
              execution.status AS execution_status,
              lease.released_at IS NOT NULL AS lease_released,
              (SELECT count(*) FROM artifacts WHERE session_id = session.id) AS artifact_count,
              (SELECT count(*) FROM session_events event
                WHERE event.session_id = session.id AND event.event_type = 'session.broken'
                  AND event.payload->>'component' = 'artifact_storage') AS broken_events,
              (SELECT byte_size::text FROM artifact_storage_usage
                WHERE scope = 'default') AS usage_bytes
         FROM sessions session
         JOIN actions action ON action.id = (SELECT id FROM actions
           WHERE session_id = session.id AND kind = 'execute' ORDER BY accepted_at DESC LIMIT 1)
         JOIN executions execution ON execution.action_id = action.id
         JOIN session_leases lease
           ON lease.session_id = session.id AND lease.session_generation = session.current_generation
        WHERE session.id = $1`,
      [session.id],
    );
    expect(durable.rows[0]).toEqual({
      action_status: "UNKNOWN",
      artifact_count: "0",
      broken_events: "1",
      execution_status: "UNKNOWN",
      lease_released: true,
      session_status: "BROKEN",
      usage_bytes: "0",
    });
    const rejectedContent = await pool.query<{ matches: string }>(
      `SELECT (
          (SELECT count(*) FROM session_events
            WHERE session_id = $1 AND payload::text LIKE '%' || $2 || '%') +
          (SELECT count(*) FROM artifacts
            WHERE session_id = $1 AND position(convert_to($2, 'UTF8') in content) > 0)
        )::text AS matches`,
      [session.id, sentinel],
    );
    expect(rejectedContent.rows[0]?.matches).toBe("0");
  }, 30_000);

  it("coalesces real node-pty callbacks into bounded durable Artifacts", async () => {
    await pool.query(
      `UPDATE artifact_storage_policies
          SET max_bytes = 1073741824, max_artifact_bytes = 16777216,
              retention_milliseconds = 604800000, cleanup_batch_size = 1000,
              updated_at = now()
        WHERE scope = 'default'`,
    );
    const root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-m10-output-")));
    fixtures.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    daemon = await startRuntimeDaemon({
      databaseUrl: databaseUrl ?? "",
      ownerId: "owner-m10-output",
      socketPath: join(root, "runtime.sock"),
    });
    await daemon.waitUntilReady();
    const rpc = new UnixRuntimeClient(daemon.socketPath);
    const session = await rpc.createSession({
      idempotencyKey: "m10-output-session",
      shell: "zsh",
      workspaceRoot: workspace,
    });
    const started = await rpc.startExecute({
      actor,
      command: `python3 -c 'import os; os.write(1, b"X" * 1000000)'`,
      idempotencyKey: "m10-output-million-bytes",
      sessionGeneration: session.generation,
      sessionId: session.id,
    });
    await rpc.waitExecution(started.execution.id);

    const aggregate = await pool.query<{
      artifact_events: string;
      max_artifact_bytes: string;
      max_event_bytes: string;
      missing_artifacts: string;
      output_bytes: string;
      output_events: string;
    }>(
      `SELECT count(*)::text AS output_events,
              coalesce(sum((event.payload->>'byteCount')::bigint), 0)::text AS output_bytes,
              count(*) FILTER (WHERE event.payload ? 'artifactRef')::text AS artifact_events,
              coalesce(max((event.payload->>'byteCount')::bigint), 0)::text AS max_event_bytes,
              coalesce(max(artifact.byte_size), 0)::text AS max_artifact_bytes,
              count(*) FILTER (
                WHERE event.payload ? 'artifactRef' AND artifact.id IS NULL
              )::text AS missing_artifacts
         FROM session_events event
         LEFT JOIN artifacts artifact ON artifact.id = event.payload->>'artifactRef'
        WHERE event.execution_id = $1 AND event.event_type = 'terminal.pty_output'`,
      [started.execution.id],
    );
    const observed = aggregate.rows[0];
    if (observed === undefined) throw new Error("Expected durable output aggregation metrics");
    expect(Number.parseInt(observed.output_events, 10)).toBeGreaterThan(100);
    expect(Number.parseInt(observed.output_events, 10)).toBeLessThan(150);
    expect(Number.parseInt(observed.output_bytes, 10)).toBeGreaterThanOrEqual(1_000_000);
    expect(Number.parseInt(observed.artifact_events, 10)).toBeGreaterThan(100);
    expect(Number.parseInt(observed.max_event_bytes, 10)).toBeLessThanOrEqual(8192);
    expect(Number.parseInt(observed.max_artifact_bytes, 10)).toBeLessThanOrEqual(8192);
    expect(observed.missing_artifacts).toBe("0");

    const retained = await pool.query<{ content: Buffer; id: string }>(
      `SELECT artifact.id, artifact.content
         FROM artifacts artifact
         JOIN session_events event ON event.payload->>'artifactRef' = artifact.id
        WHERE event.execution_id = $1
        ORDER BY event.event_sequence ASC
        LIMIT 1`,
      [started.execution.id],
    );
    const retainedArtifact = retained.rows[0];
    if (retainedArtifact === undefined) throw new Error("Expected one retained Artifact fixture");
    const read = await rpc.readArtifact({
      artifactId: retainedArtifact.id,
      generation: session.generation,
      offsetBytes: 0,
      sessionId: session.id,
    });
    if (read.kind !== "found")
      throw new Error("Expected the retained Artifact through Runtime RPC");
    expect(Buffer.from(read.contentBase64, "base64")).toEqual(retainedArtifact.content);
    expect(read).not.toHaveProperty("sha256");

    const other = await rpc.createSession({
      idempotencyKey: "m10-output-other-session",
      shell: "zsh",
      workspaceRoot: workspace,
    });
    const crossSession = await rpc.readArtifact({
      artifactId: retainedArtifact.id,
      generation: other.generation,
      offsetBytes: 0,
      sessionId: other.id,
    });
    const missing = await rpc.readArtifact({
      artifactId: "art_missing",
      generation: other.generation,
      offsetBytes: 0,
      sessionId: other.id,
    });
    expect({ ...crossSession, artifactId: "same" }).toEqual({ ...missing, artifactId: "same" });

    await pool.query(
      "UPDATE artifacts SET expires_at = now() - interval '1 second' WHERE id = $1",
      [retainedArtifact.id],
    );
    await expect(
      rpc.readArtifact({
        artifactId: retainedArtifact.id,
        generation: session.generation,
        offsetBytes: 0,
        sessionId: session.id,
      }),
    ).resolves.toMatchObject({ kind: "expired" });

    await rpc.closeSession(other.id, other.generation);
    await rpc.closeSession(session.id, session.generation);
  }, 30_000);
});

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Runtime state");
}
