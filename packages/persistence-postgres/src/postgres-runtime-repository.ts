import { randomUUID } from "node:crypto";

import type { SessionFence } from "@iterminal/application";
import type { Actor, SessionStatus, ShellKind } from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";
import { Pool, type PoolClient } from "pg";

import { migrateDatabase } from "./migrate.js";
import { guardPostgresPool } from "./postgres-pool.js";
import { assertSessionFence, throwSessionLeaseLost } from "./session-fencing.js";

const DEFAULT_MAX_PENDING_OUTBOX = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const OUTBOX_ADMISSION_LOCK = 1_746_883_921;

export interface PostgresRuntimeRepositoryOptions {
  readonly beforeAcceptExecuteCommit?: () => void;
  readonly maxPendingOutbox?: number;
  readonly statementTimeoutMilliseconds?: number;
  readonly requireSessionFence?: boolean;
}

export interface CreateDurableSession {
  readonly id: string;
  readonly generation: number;
  readonly shell: ShellKind;
  readonly workspaceRoot: string;
  readonly ownerId: string;
  readonly shellPid?: number;
  readonly integrationVersion: string;
  readonly createdAt: Date;
}

export interface AcceptExecuteTransaction {
  readonly actionId: string;
  readonly executionId: string;
  readonly eventId: string;
  readonly outboxId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly actor: Actor;
  readonly command: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly acceptedAt: Date;
  readonly dispatchingEventId?: string;
  readonly dispatchingAt?: Date;
  readonly expectedActionSequence?: number;
  readonly failpoint?: "before_commit";
  readonly fence?: SessionFence;
}

export interface AcceptedExecute {
  readonly actionId: string;
  readonly executionId: string;
  readonly actionSequence: number;
  readonly replayed: boolean;
}

export interface RecoveryResult {
  readonly brokenSessions: number;
  readonly unknownExecutions: number;
}

export interface SnapshotUpdate {
  readonly sessionId: string;
  readonly generation: number;
  readonly cwd?: string;
  readonly activeExecutionId?: string;
  readonly screenVersion: number;
  readonly confidence: string;
  readonly observedAt: Date;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface CheckpointUpdate {
  readonly sessionId: string;
  readonly sourceGeneration: number;
  readonly checkpointVersion: number;
  readonly cwd: string;
  readonly shell: ShellKind;
  readonly filteredEnv: Readonly<Record<string, string>>;
  readonly contentHash: string;
  readonly observedAt: Date;
  readonly workspaceRoot: string;
}

export class PostgresRuntimeRepository {
  readonly #pool: Pool;
  readonly #beforeAcceptExecuteCommit: (() => void) | undefined;
  readonly #maxPendingOutbox: number;
  readonly #requireSessionFence: boolean;

  public constructor(connectionString: string, options: PostgresRuntimeRepositoryOptions = {}) {
    this.#beforeAcceptExecuteCommit = options.beforeAcceptExecuteCommit;
    this.#requireSessionFence = options.requireSessionFence ?? false;
    this.#maxPendingOutbox = positiveInteger(
      options.maxPendingOutbox ?? DEFAULT_MAX_PENDING_OUTBOX,
      "maxPendingOutbox",
    );
    const statementTimeoutMilliseconds = positiveInteger(
      options.statementTimeoutMilliseconds ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      "statementTimeoutMilliseconds",
    );
    this.#pool = guardPostgresPool(
      new Pool({
        connectionString,
        connectionTimeoutMillis: 5_000,
        max: 20,
        query_timeout: statementTimeoutMilliseconds,
        statement_timeout: statementTimeoutMilliseconds,
      }),
    );
  }

  public async migrate(): Promise<void> {
    await migrateDatabase(this.#pool);
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }

  public async createReadySession(input: CreateDurableSession): Promise<void> {
    await this.#transaction(async (client) => {
      await client.query(
        `INSERT INTO sessions
          (id, current_generation, status, shell, workspace_root, owner_id, created_at)
         VALUES ($1, $2, 'READY', $3, $4, $5, $6)`,
        [
          input.id,
          input.generation,
          input.shell,
          input.workspaceRoot,
          input.ownerId,
          input.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO session_generations
          (session_id, generation, owner_id, shell_pid, integration_version, status, started_at)
         VALUES ($1, $2, $3, $4, $5, 'READY', $6)`,
        [
          input.id,
          input.generation,
          input.ownerId,
          input.shellPid ?? null,
          input.integrationVersion,
          input.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO interaction_guards
          (session_id, session_generation, input_policy, state_version)
         VALUES ($1, $2, 'human_guarded', 1)`,
        [input.id, input.generation],
      );
    });
  }

  public async acceptExecute(input: AcceptExecuteTransaction): Promise<AcceptedExecute> {
    return this.#transaction(async (client) => {
      if (input.fence === undefined) {
        if (this.#requireSessionFence) {
          throw new RuntimeError(
            "SESSION_LEASE_LOST",
            "Execute admission requires an explicit Session fence",
            { generation: input.generation, sessionId: input.sessionId },
            false,
          );
        }
      } else {
        if (
          input.fence.sessionId !== input.sessionId ||
          input.fence.generation !== input.generation
        ) {
          throwSessionLeaseLost(input.fence);
        }
        await assertSessionFence(client, input.fence);
      }
      const replay = await findExecuteReplay(client, input);
      if (replay !== undefined) return replay;

      await client.query("SELECT pg_advisory_xact_lock($1)", [OUTBOX_ADMISSION_LOCK]);
      const concurrentReplay = await findExecuteReplay(client, input);
      if (concurrentReplay !== undefined) return concurrentReplay;
      const backlog = await client.query<{ pending: string }>(
        "SELECT count(*) AS pending FROM outbox WHERE published_at IS NULL",
      );
      const pending = Number.parseInt(backlog.rows[0]?.pending ?? "0", 10);
      if (pending >= this.#maxPendingOutbox) {
        throw new RuntimeError(
          "BACKPRESSURE",
          "Pending Outbox capacity is exhausted",
          { maxPendingOutbox: this.#maxPendingOutbox, pendingOutbox: pending },
          true,
        );
      }

      const reserved = await client.query<{ next_action_sequence: string; owner_id: string }>(
        `UPDATE sessions
            SET status = 'RESERVED',
                active_execution_id = $3,
                next_action_sequence = next_action_sequence + 1,
                updated_at = now()
          WHERE id = $1 AND current_generation = $2 AND status = 'READY'
        RETURNING next_action_sequence, owner_id`,
        [input.sessionId, input.generation, input.executionId],
      );
      const reservation =
        reserved.rows[0] ??
        (await this.#throwReservationError(client, input.sessionId, input.generation));

      await client.query(
        `INSERT INTO actors (id, actor_type, principal, client)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET actor_type = EXCLUDED.actor_type,
               principal = EXCLUDED.principal,
               client = EXCLUDED.client`,
        [input.actor.id, input.actor.type, input.actor.principal, input.actor.client],
      );
      const sequence = Number.parseInt(reservation.next_action_sequence, 10);
      if (input.expectedActionSequence !== undefined && sequence !== input.expectedActionSequence) {
        throw new RuntimeError("DELIVERY_UNKNOWN", "Live and durable Action sequence diverged", {
          durableActionSequence: sequence,
          liveActionSequence: input.expectedActionSequence,
        });
      }
      await client.query(
        `INSERT INTO actions
          (id, session_id, session_generation, actor_id, kind, action_sequence,
           idempotency_key, request_hash, payload, status, accepted_at)
         VALUES ($1, $2, $3, $4, 'execute', $5, $6, $7, $8, $9, $10)`,
        [
          input.actionId,
          input.sessionId,
          input.generation,
          input.actor.id,
          sequence,
          input.idempotencyKey,
          input.requestHash,
          JSON.stringify({ command: input.command }),
          input.dispatchingEventId === undefined ? "ACCEPTED" : "DISPATCHING",
          input.acceptedAt,
        ],
      );
      await client.query(
        `INSERT INTO executions
          (id, action_id, session_id, session_generation, owner_id, status, command)
         VALUES ($1, $2, $3, $4, $5, 'DISPATCHING', $6)`,
        [
          input.executionId,
          input.actionId,
          input.sessionId,
          input.generation,
          reservation.owner_id,
          input.command,
        ],
      );
      const eventSequence = await nextEventSequence(client, input.sessionId, input.generation);
      await client.query(
        `INSERT INTO session_events
          (id, session_id, session_generation, event_sequence, event_type,
           action_id, execution_id, actor_id, payload, created_at)
         VALUES ($1, $2, $3, $4, 'action.accepted', $5, $6, $7, '{}'::jsonb, $8)`,
        [
          input.eventId,
          input.sessionId,
          input.generation,
          eventSequence,
          input.actionId,
          input.executionId,
          input.actor.id,
          input.acceptedAt,
        ],
      );
      if (input.dispatchingEventId !== undefined) {
        const dispatchingSequence = await nextEventSequence(
          client,
          input.sessionId,
          input.generation,
        );
        await client.query(
          `INSERT INTO session_events
            (id, session_id, session_generation, event_sequence, event_type,
             action_id, execution_id, actor_id, payload, created_at)
           VALUES ($1, $2, $3, $4, 'action.dispatching', $5, $6, $7, '{}'::jsonb, $8)`,
          [
            input.dispatchingEventId,
            input.sessionId,
            input.generation,
            dispatchingSequence,
            input.actionId,
            input.executionId,
            input.actor.id,
            input.dispatchingAt ?? input.acceptedAt,
          ],
        );
      }
      await client.query(
        `INSERT INTO outbox
          (id, aggregate_type, aggregate_id, event_type, payload, created_at)
         VALUES ($1, 'session', $2, 'ExecutionReady', $3, $4)`,
        [
          input.outboxId,
          input.sessionId,
          JSON.stringify({ executionId: input.executionId, generation: input.generation }),
          input.acceptedAt,
        ],
      );
      await client.query(
        `UPDATE session_generations SET status = 'RESERVED'
          WHERE session_id = $1 AND generation = $2`,
        [input.sessionId, input.generation],
      );
      this.#beforeAcceptExecuteCommit?.();
      if (input.failpoint === "before_commit") {
        throw new Error("Injected failure before commit");
      }
      return {
        actionId: input.actionId,
        actionSequence: sequence,
        executionId: input.executionId,
        replayed: false,
      };
    });
  }

  public async recoverLostOwner(ownerId: string, reason: string): Promise<RecoveryResult> {
    return this.#transaction(async (client) => {
      const executions = await client.query<{ id: string; session_id: string }>(
        `WITH current AS MATERIALIZED (
           SELECT id, version FROM executions
            WHERE owner_id = $1 AND status IN ('DISPATCHING', 'RUNNING')
            FOR UPDATE
         )
         UPDATE executions execution
            SET status = 'UNKNOWN', unknown_reason = $2, finished_at = now(),
                version = execution.version + 1
           FROM current
          WHERE execution.id = current.id AND execution.version = current.version
        RETURNING execution.id, execution.session_id`,
        [ownerId, reason],
      );
      await client.query(
        `UPDATE actions a
            SET status = 'UNKNOWN', updated_at = now()
           FROM executions e
          WHERE e.action_id = a.id AND e.owner_id = $1 AND e.status = 'UNKNOWN'`,
        [ownerId],
      );
      const sessions = await client.query<{ id: string; current_generation: number }>(
        `UPDATE sessions
            SET status = 'BROKEN', active_execution_id = NULL, updated_at = now()
          WHERE owner_id = $1 AND status IN ('STARTING', 'READY', 'RESERVED', 'RUNNING')
        RETURNING id, current_generation`,
        [ownerId],
      );
      await client.query(
        `UPDATE session_generations
            SET status = 'BROKEN', broken_at = now(), broken_reason = $2
          WHERE owner_id = $1 AND status IN ('STARTING', 'READY', 'RESERVED', 'RUNNING')`,
        [ownerId, reason],
      );
      for (const session of sessions.rows) {
        const sequence = await nextEventSequence(client, session.id, session.current_generation);
        await client.query(
          `INSERT INTO session_events
            (id, session_id, session_generation, event_sequence, event_type, payload, created_at)
           VALUES ($1, $2, $3, $4, 'session.broken', $5, now())`,
          [
            `evt_recovery_${randomUUID()}`,
            session.id,
            session.current_generation,
            sequence,
            JSON.stringify({ reason }),
          ],
        );
      }
      return {
        brokenSessions: sessions.rowCount ?? 0,
        unknownExecutions: executions.rowCount ?? 0,
      };
    });
  }

  public async upsertSnapshot(input: SnapshotUpdate): Promise<boolean> {
    const result = await this.#pool.query(
      `INSERT INTO session_snapshots
        (session_id, session_generation, cwd, active_execution_id, screen_version,
         confidence, observed_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (session_id, session_generation) DO UPDATE
         SET cwd = EXCLUDED.cwd,
             active_execution_id = EXCLUDED.active_execution_id,
             screen_version = EXCLUDED.screen_version,
             confidence = EXCLUDED.confidence,
             observed_at = EXCLUDED.observed_at,
             payload = EXCLUDED.payload
       WHERE session_snapshots.observed_at <= EXCLUDED.observed_at`,
      [
        input.sessionId,
        input.generation,
        input.cwd ?? null,
        input.activeExecutionId ?? null,
        input.screenVersion,
        input.confidence,
        input.observedAt,
        JSON.stringify(input.payload ?? {}),
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async upsertCheckpoint(input: CheckpointUpdate): Promise<boolean> {
    const result = await this.#pool.query(
      `INSERT INTO shell_checkpoints
        (session_id, source_generation, checkpoint_version, cwd, shell,
         filtered_env, content_hash, observed_at, workspace_root)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (session_id, source_generation) DO UPDATE
         SET checkpoint_version = EXCLUDED.checkpoint_version,
             cwd = EXCLUDED.cwd,
             shell = EXCLUDED.shell,
             filtered_env = EXCLUDED.filtered_env,
             content_hash = EXCLUDED.content_hash,
             observed_at = EXCLUDED.observed_at,
             workspace_root = EXCLUDED.workspace_root
       WHERE shell_checkpoints.observed_at <= EXCLUDED.observed_at`,
      [
        input.sessionId,
        input.sourceGeneration,
        input.checkpointVersion,
        input.cwd,
        input.shell,
        JSON.stringify(input.filteredEnv),
        input.contentHash,
        input.observedAt,
        input.workspaceRoot,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async appendOutputChunk(input: {
    readonly eventId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly executionId?: string;
    readonly data: string;
    readonly createdAt: Date;
  }): Promise<number> {
    return this.#transaction(async (client) => {
      const sequence = await nextEventSequence(client, input.sessionId, input.generation);
      await client.query(
        `INSERT INTO session_events
          (id, session_id, session_generation, event_sequence, event_type,
           execution_id, payload, created_at, search_text)
         VALUES ($1, $2, $3, $4, 'terminal.pty_output', $5, $6, $7, $8)`,
        [
          input.eventId,
          input.sessionId,
          input.generation,
          sequence,
          input.executionId ?? null,
          JSON.stringify({
            byteLength: Buffer.byteLength(input.data, "utf8"),
            data: input.data,
          }),
          input.createdAt,
          input.data,
        ],
      );
      return sequence;
    });
  }

  public async applyRetention(now: Date): Promise<number> {
    const result = await this.#pool.query(
      `WITH policy AS (
         SELECT max_age_days, max_events_per_generation
           FROM retention_policies WHERE scope = 'default'
       ), ranked AS (
         SELECT id, created_at,
                row_number() OVER (
                  PARTITION BY session_id, session_generation ORDER BY event_sequence DESC
                ) AS newest_rank
           FROM session_events
       )
       DELETE FROM session_events e
        USING ranked r, policy p
        WHERE e.id = r.id
          AND (r.created_at < $1::timestamptz - make_interval(days => p.max_age_days)
               OR r.newest_rank > p.max_events_per_generation)`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  public async inspectSession(sessionId: string): Promise<{
    readonly status: SessionStatus;
    readonly activeExecutionId: string | null;
    readonly actionCount: number;
    readonly executionStatus: string | null;
    readonly eventCount: number;
    readonly outboxCount: number;
  }> {
    const result = await this.#pool.query<{
      status: SessionStatus;
      active_execution_id: string | null;
      action_count: string;
      execution_status: string | null;
      event_count: string;
      outbox_count: string;
    }>(
      `SELECT s.status, s.active_execution_id,
              (SELECT count(*) FROM actions a WHERE a.session_id = s.id) AS action_count,
              (SELECT e.status FROM executions e
                WHERE e.session_id = s.id ORDER BY e.version DESC, e.id DESC LIMIT 1) AS execution_status,
              (SELECT count(*) FROM session_events v WHERE v.session_id = s.id) AS event_count,
              (SELECT count(*) FROM outbox o WHERE o.aggregate_id = s.id) AS outbox_count
         FROM sessions s WHERE s.id = $1`,
      [sessionId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new RuntimeError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
    }
    return {
      actionCount: Number.parseInt(row.action_count, 10),
      activeExecutionId: row.active_execution_id,
      eventCount: Number.parseInt(row.event_count, 10),
      executionStatus: row.execution_status,
      outboxCount: Number.parseInt(row.outbox_count, 10),
      status: row.status,
    };
  }

  async #throwReservationError(
    client: PoolClient,
    sessionId: string,
    generation: number,
  ): Promise<never> {
    const result = await client.query<{
      current_generation: number;
      status: SessionStatus;
      active_execution_id: string | null;
    }>(`SELECT current_generation, status, active_execution_id FROM sessions WHERE id = $1`, [
      sessionId,
    ]);
    const session = result.rows[0];
    if (session === undefined) {
      throw new RuntimeError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
    }
    if (session.current_generation !== generation) {
      throw new RuntimeError("SESSION_GENERATION_CHANGED", "Session generation changed", {
        currentGeneration: session.current_generation,
      });
    }
    if (session.status === "RESERVED" || session.status === "RUNNING") {
      throw new RuntimeError(
        "PTY_BUSY",
        "Session already has an active ExecuteAction",
        {
          activeExecutionId: session.active_execution_id,
          availableActions: ["wait", "send_input", "control", "fork_session"],
        },
        true,
      );
    }
    throw new RuntimeError("SESSION_NOT_READY", `Session is ${session.status}`);
  }

  async #transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function findExecuteReplay(
  client: PoolClient,
  input: AcceptExecuteTransaction,
): Promise<AcceptedExecute | undefined> {
  const replay = await client.query<{
    action_sequence: string;
    execution_id: string;
    id: string;
    request_hash: string;
  }>(
    `SELECT a.id, a.request_hash, a.action_sequence, e.id AS execution_id
       FROM actions a
       JOIN executions e ON e.action_id = a.id
      WHERE a.session_id = $1 AND a.actor_id = $2 AND a.idempotency_key = $3`,
    [input.sessionId, input.actor.id, input.idempotencyKey],
  );
  const previous = replay.rows[0];
  if (previous === undefined) return undefined;
  if (previous.request_hash !== input.requestHash) {
    throw new RuntimeError(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency key was used with a different request hash",
      { actionId: previous.id },
    );
  }
  return {
    actionId: previous.id,
    actionSequence: Number.parseInt(previous.action_sequence, 10),
    executionId: previous.execution_id,
    replayed: true,
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeError("INVALID_REQUEST", `${name} must be a positive integer`, {
      [name]: value,
    });
  }
  return value;
}

async function nextEventSequence(
  client: PoolClient,
  sessionId: string,
  generation: number,
): Promise<number> {
  const result = await client.query<{ next_event_sequence: string }>(
    `UPDATE session_generations
        SET next_event_sequence = next_event_sequence + 1
      WHERE session_id = $1 AND generation = $2
    RETURNING next_event_sequence`,
    [sessionId, generation],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RuntimeError("SESSION_GENERATION_CHANGED", "Session generation not found");
  }
  return Number.parseInt(row.next_event_sequence, 10);
}
