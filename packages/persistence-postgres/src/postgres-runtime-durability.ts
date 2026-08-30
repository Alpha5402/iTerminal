import { randomUUID } from "node:crypto";

import type {
  DurableExecuteAdmission,
  DurableExecuteAdmissionResult,
  DurableSessionEvent,
  RuntimeDurability,
} from "@iterminal/application";
import type {
  ControlAction,
  ActorType,
  EventPage,
  Execution,
  InputAction,
  Session,
  SessionAction,
  SessionStatus,
} from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";
import { Pool, type PoolClient } from "pg";

import { PostgresObservationRepository } from "./postgres-observation-repository.js";
import { PostgresRuntimeRepository } from "./postgres-runtime-repository.js";

export interface PostgresRuntimeDurabilityOptions {
  readonly beforeAcceptExecuteCommit?: () => void;
  readonly maxPendingOutbox?: number;
  readonly statementTimeoutMilliseconds?: number;
}

export class PostgresRuntimeDurability implements RuntimeDurability {
  readonly #pool: Pool;
  readonly #observation: PostgresObservationRepository;
  readonly #admission: PostgresRuntimeRepository;

  public constructor(connectionString: string, options: PostgresRuntimeDurabilityOptions = {}) {
    const statementTimeoutMilliseconds = positiveInteger(
      options.statementTimeoutMilliseconds ?? 30_000,
      "statementTimeoutMilliseconds",
    );
    this.#pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 5_000,
      max: 20,
      query_timeout: statementTimeoutMilliseconds,
      statement_timeout: statementTimeoutMilliseconds,
    });
    this.#observation = new PostgresObservationRepository(connectionString);
    this.#admission = new PostgresRuntimeRepository(connectionString, options);
  }

  public async migrate(): Promise<void> {
    await this.#admission.migrate();
  }

  public async close(): Promise<void> {
    await Promise.all([this.#pool.end(), this.#observation.close(), this.#admission.close()]);
  }

  public async createSession(
    session: Session,
    events: readonly DurableSessionEvent[],
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await client.query(
        `INSERT INTO sessions
          (id, current_generation, status, shell, workspace_root, owner_id,
           next_action_sequence, screen_version, created_at)
         VALUES ($1, $2, 'STARTING', $3, $4, $5, $6, $7, $8)`,
        [
          session.id,
          session.generation,
          session.shell,
          session.workspaceRoot,
          session.ownerId,
          session.actionSequence,
          session.screenVersion,
          session.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO session_generations
          (session_id, generation, owner_id, integration_version, status, started_at)
         VALUES ($1, $2, $3, 'runtime-v1', 'STARTING', $4)`,
        [session.id, session.generation, session.ownerId, session.createdAt],
      );
      await insertEvents(client, events);
    });
  }

  public async markSessionReady(
    session: Session,
    shellPid: number,
    event: DurableSessionEvent,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await expectOne(
        client,
        `UPDATE sessions SET status = 'READY', updated_at = now()
          WHERE id = $1 AND current_generation = $2 AND owner_id = $3 AND status = 'STARTING'`,
        [session.id, session.generation, session.ownerId],
        "Session did not transition STARTING -> READY",
      );
      await expectOne(
        client,
        `UPDATE session_generations
            SET status = 'READY', shell_pid = $4
          WHERE session_id = $1 AND generation = $2 AND owner_id = $3 AND status = 'STARTING'`,
        [session.id, session.generation, session.ownerId, shellPid],
        "Session generation did not transition STARTING -> READY",
      );
      await insertEvents(client, [event]);
    });
  }

  public async markSessionBroken(
    session: Session,
    events: readonly DurableSessionEvent[],
    reason: string,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await client.query(
        `UPDATE executions
            SET status = 'UNKNOWN', unknown_reason = $3, finished_at = now(), version = version + 1
          WHERE session_id = $1 AND session_generation = $2
            AND status IN ('DISPATCHING', 'RUNNING')`,
        [session.id, session.generation, reason],
      );
      await client.query(
        `UPDATE actions a SET status = 'UNKNOWN', updated_at = now()
          FROM executions e
         WHERE e.action_id = a.id AND e.session_id = $1 AND e.session_generation = $2
           AND e.status = 'UNKNOWN'`,
        [session.id, session.generation],
      );
      await client.query(
        `UPDATE sessions SET status = 'BROKEN', active_execution_id = NULL, updated_at = now()
          WHERE id = $1 AND current_generation = $2 AND status <> 'CLOSED'`,
        [session.id, session.generation],
      );
      await client.query(
        `UPDATE session_generations
            SET status = 'BROKEN', broken_at = now(), broken_reason = $3
          WHERE session_id = $1 AND generation = $2 AND status <> 'CLOSED'`,
        [session.id, session.generation, reason],
      );
      await insertEvents(client, events);
    });
  }

  public async closeSession(session: Session, event: DurableSessionEvent): Promise<void> {
    await this.#transaction(async (client) => {
      await client.query(
        `UPDATE executions
            SET status = 'UNKNOWN', unknown_reason = 'session closed while active',
                finished_at = now(), version = version + 1
          WHERE session_id = $1 AND session_generation = $2
            AND status IN ('DISPATCHING', 'RUNNING')`,
        [session.id, session.generation],
      );
      await client.query(
        `UPDATE actions a SET status = 'UNKNOWN', updated_at = now()
          FROM executions e
         WHERE e.action_id = a.id AND e.session_id = $1 AND e.session_generation = $2
           AND e.status = 'UNKNOWN'`,
        [session.id, session.generation],
      );
      await expectOne(
        client,
        `UPDATE sessions
            SET status = 'CLOSED', active_execution_id = NULL, updated_at = now()
          WHERE id = $1 AND current_generation = $2 AND status <> 'CLOSED'`,
        [session.id, session.generation],
        "Session did not close",
      );
      await expectOne(
        client,
        `UPDATE session_generations SET status = 'CLOSED', closed_at = now()
          WHERE session_id = $1 AND generation = $2 AND status <> 'CLOSED'`,
        [session.id, session.generation],
        "Session generation did not close",
      );
      await insertEvents(client, [event]);
    });
  }

  public async acceptExecute(
    input: DurableExecuteAdmission,
  ): Promise<DurableExecuteAdmissionResult> {
    return this.#admission.acceptExecute({
      acceptedAt: new Date(input.action.acceptedAt),
      actionId: input.action.id,
      actor: input.action.actor,
      command: input.action.command,
      dispatchingAt: new Date(input.dispatchingEvent.observedAt),
      dispatchingEventId: input.dispatchingEvent.id,
      eventId: input.acceptedEvent.id,
      executionId: input.execution.id,
      expectedActionSequence: input.action.actionSequence,
      generation: input.action.sessionGeneration,
      idempotencyKey: input.action.idempotencyKey,
      outboxId: `out_${randomUUID()}`,
      requestHash: input.action.requestHash,
      sessionId: input.action.sessionId,
    });
  }

  public async markExecutionRunning(input: {
    readonly session: Session;
    readonly action: Extract<SessionAction, { type: "execute" }>;
    readonly execution: Execution;
    readonly event: DurableSessionEvent;
  }): Promise<void> {
    await this.#transaction(async (client) => {
      await expectOne(
        client,
        `UPDATE executions
            SET status = 'RUNNING', started_at = $2, version = version + 1
          WHERE id = $1 AND status = 'DISPATCHING'`,
        [input.execution.id, input.execution.startedAt],
        "Execution did not transition DISPATCHING -> RUNNING",
      );
      await expectOne(
        client,
        `UPDATE actions SET status = 'RUNNING', updated_at = now()
          WHERE id = $1 AND status = 'DISPATCHING'`,
        [input.action.id],
        "Execute Action did not transition DISPATCHING -> RUNNING",
      );
      await expectOne(
        client,
        `UPDATE sessions SET status = 'RUNNING', updated_at = now()
          WHERE id = $1 AND current_generation = $2 AND status = 'RESERVED'
            AND active_execution_id = $3`,
        [input.session.id, input.session.generation, input.execution.id],
        "Session did not transition RESERVED -> RUNNING",
      );
      await client.query(
        `UPDATE session_generations SET status = 'RUNNING'
          WHERE session_id = $1 AND generation = $2 AND status = 'RESERVED'`,
        [input.session.id, input.session.generation],
      );
      await insertEvents(client, [input.event]);
    });
  }

  public async markExecutionWriteAttempted(input: {
    readonly session: Session;
    readonly action: Extract<SessionAction, { type: "execute" }>;
    readonly execution: Execution;
    readonly event: DurableSessionEvent;
  }): Promise<void> {
    await this.#transaction(async (client) => {
      const execution = await client.query(
        `SELECT 1 FROM executions
          WHERE id = $1 AND session_id = $2 AND session_generation = $3
            AND owner_id = $4 AND status = 'DISPATCHING'
          FOR UPDATE`,
        [input.execution.id, input.session.id, input.session.generation, input.session.ownerId],
      );
      if (execution.rowCount !== 1) {
        throw new RuntimeError("DELIVERY_UNKNOWN", "Execution write attempt is no longer current");
      }
      const session = await client.query(
        `SELECT 1 FROM sessions
          WHERE id = $1 AND current_generation = $2 AND owner_id = $3
            AND status = 'RESERVED' AND active_execution_id = $4
          FOR UPDATE`,
        [input.session.id, input.session.generation, input.session.ownerId, input.execution.id],
      );
      if (session.rowCount !== 1) {
        throw new RuntimeError("DELIVERY_UNKNOWN", "Session is no longer reserved for dispatch");
      }
      await insertEvents(client, [input.event]);
    });
  }

  public async finishExecution(input: {
    readonly session: Session;
    readonly action: Extract<SessionAction, { type: "execute" }>;
    readonly execution: Execution;
    readonly events: readonly DurableSessionEvent[];
  }): Promise<void> {
    await this.#transaction(async (client) => {
      if (input.execution.status !== "COMPLETED" && input.execution.status !== "INTERRUPTED") {
        throw new RuntimeError("INVALID_REQUEST", "Execution terminal status is invalid");
      }
      await expectOne(
        client,
        `UPDATE executions
            SET status = $2, exit_code = $3, cwd = $4, finished_at = $5, version = version + 1
          WHERE id = $1 AND status IN ('DISPATCHING', 'RUNNING')`,
        [
          input.execution.id,
          input.execution.status,
          input.execution.exitCode,
          input.execution.cwd,
          input.execution.finishedAt,
        ],
        "Execution did not reach its terminal state",
      );
      await expectOne(
        client,
        `UPDATE actions SET status = $2, updated_at = now()
          WHERE id = $1 AND status IN ('DISPATCHING', 'RUNNING')`,
        [input.action.id, input.action.status],
        "Execute Action did not reach its terminal state",
      );
      await expectOne(
        client,
        `UPDATE sessions
            SET status = 'READY', active_execution_id = NULL,
                screen_version = $4, updated_at = now()
          WHERE id = $1 AND current_generation = $2
            AND active_execution_id = $3 AND status IN ('RESERVED', 'RUNNING')`,
        [
          input.session.id,
          input.session.generation,
          input.execution.id,
          input.session.screenVersion,
        ],
        "Session did not return to READY",
      );
      await client.query(
        `UPDATE session_generations SET status = 'READY'
          WHERE session_id = $1 AND generation = $2 AND status IN ('RESERVED', 'RUNNING')`,
        [input.session.id, input.session.generation],
      );
      await insertEvents(client, input.events);
      await upsertSnapshot(client, input.session, input.execution);
    });
  }

  public async failExecution(input: {
    readonly session: Session;
    readonly action: Extract<SessionAction, { type: "execute" }>;
    readonly execution: Execution;
    readonly events: readonly DurableSessionEvent[];
    readonly reason: string;
  }): Promise<void> {
    await this.#transaction(async (client) => {
      await client.query(
        `UPDATE executions
            SET status = 'FAILED', unknown_reason = $2, finished_at = $3, version = version + 1
          WHERE id = $1 AND status IN ('DISPATCHING', 'RUNNING')`,
        [input.execution.id, input.reason, input.execution.finishedAt],
      );
      await client.query(
        `UPDATE actions SET status = 'FAILED', updated_at = now()
          WHERE id = $1 AND status IN ('DISPATCHING', 'RUNNING')`,
        [input.action.id],
      );
      await client.query(
        `UPDATE sessions SET status = 'BROKEN', active_execution_id = NULL, updated_at = now()
          WHERE id = $1 AND current_generation = $2`,
        [input.session.id, input.session.generation],
      );
      await client.query(
        `UPDATE session_generations
            SET status = 'BROKEN', broken_at = now(), broken_reason = $3
          WHERE session_id = $1 AND generation = $2`,
        [input.session.id, input.session.generation, input.reason],
      );
      await insertEvents(client, input.events);
    });
  }

  public async acceptInteraction(
    action: InputAction | ControlAction,
    event: DurableSessionEvent,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      const replay = await findReplay(
        client,
        action.sessionId,
        action.actor.id,
        action.idempotencyKey,
      );
      if (replay !== undefined) {
        if (replay.requestHash !== action.requestHash || replay.actionId !== action.id) {
          throw new RuntimeError(
            "IDEMPOTENCY_KEY_REUSED",
            "Interaction idempotency key already exists",
            { actionId: replay.actionId },
          );
        }
        return;
      }
      const session = await client.query<{
        active_execution_id: string | null;
        current_generation: number;
        next_action_sequence: string;
        screen_version: string;
        status: SessionStatus;
      }>(
        `SELECT current_generation, status, active_execution_id,
                next_action_sequence, screen_version
           FROM sessions WHERE id = $1 FOR UPDATE`,
        [action.sessionId],
      );
      const current = session.rows[0];
      if (current === undefined) {
        throw new RuntimeError("SESSION_NOT_FOUND", `Session not found: ${action.sessionId}`);
      }
      if (current.current_generation !== action.sessionGeneration) {
        throw new RuntimeError("SESSION_GENERATION_CHANGED", "Session generation changed", {
          currentGeneration: current.current_generation,
        });
      }
      if (
        current.status !== "RUNNING" ||
        current.active_execution_id !== action.targetExecutionId
      ) {
        throw new RuntimeError("EXECUTION_CHANGED", "Interaction target is no longer active", {
          activeExecutionId: current.active_execution_id,
          targetExecutionId: action.targetExecutionId,
        });
      }
      if (
        action.type === "input" &&
        action.expectedScreenVersion !== undefined &&
        Number.parseInt(current.screen_version, 10) !== action.expectedScreenVersion
      ) {
        throw new RuntimeError("SCREEN_CHANGED", "Expected screen version is stale", {
          currentScreenVersion: Number.parseInt(current.screen_version, 10),
          expectedScreenVersion: action.expectedScreenVersion,
        });
      }
      const durableSequence = Number.parseInt(current.next_action_sequence, 10) + 1;
      if (durableSequence !== action.actionSequence) {
        throw new RuntimeError("DELIVERY_UNKNOWN", "Live and durable Action sequence diverged", {
          durableActionSequence: durableSequence,
          liveActionSequence: action.actionSequence,
        });
      }
      await client.query(
        `UPDATE sessions SET next_action_sequence = $2, updated_at = now() WHERE id = $1`,
        [action.sessionId, action.actionSequence],
      );
      await upsertActor(client, action);
      await client.query(
        `INSERT INTO actions
          (id, session_id, session_generation, actor_id, kind, action_sequence,
           idempotency_key, request_hash, payload, status, accepted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACCEPTED', $10)`,
        [
          action.id,
          action.sessionId,
          action.sessionGeneration,
          action.actor.id,
          action.type,
          action.actionSequence,
          action.idempotencyKey,
          action.requestHash,
          JSON.stringify(actionPayload(action)),
          action.acceptedAt,
        ],
      );
      await insertEvents(client, [event]);
    });
  }

  public async finishInteraction(
    action: InputAction | ControlAction,
    event: DurableSessionEvent,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await expectOne(
        client,
        `UPDATE actions SET status = $2, updated_at = now()
          WHERE id = $1 AND status = 'ACCEPTED'`,
        [action.id, action.status],
        "Interaction Action did not reach its delivery state",
      );
      await insertEvents(client, [event]);
    });
  }

  public async markInteractionWriteAttempted(
    action: InputAction | ControlAction,
    event: DurableSessionEvent,
    ownerId: string,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      const current = await client.query(
        `SELECT 1
           FROM actions a
           JOIN sessions s ON s.id = a.session_id
          WHERE a.id = $1 AND a.session_generation = $2 AND a.kind = $3
            AND a.status = 'ACCEPTED'
            AND s.current_generation = $2 AND s.owner_id = $4
            AND s.status = 'RUNNING' AND s.active_execution_id = $5
          FOR UPDATE OF a, s`,
        [action.id, action.sessionGeneration, action.type, ownerId, action.targetExecutionId],
      );
      if (current.rowCount !== 1) {
        throw new RuntimeError(
          "DELIVERY_UNKNOWN",
          "Interaction write attempt is no longer current",
          { actionId: action.id, targetExecutionId: action.targetExecutionId },
        );
      }
      await insertEvents(client, [event]);
    });
  }

  public async appendEvent(event: DurableSessionEvent): Promise<void> {
    if (event.type === "terminal.pty_output" && typeof event.payload.data === "string") {
      await this.#observation.appendOutput({
        ...(event.actionId === undefined ? {} : { actionId: event.actionId }),
        ...(event.actor === undefined ? {} : { actor: event.actor }),
        createdAt: new Date(event.observedAt),
        data: event.payload.data,
        eventId: event.id,
        ...(event.executionId === undefined ? {} : { executionId: event.executionId }),
        generation: event.sessionGeneration,
        payload: Object.fromEntries(
          Object.entries(event.payload).filter(([key]) => key !== "data" && key !== "byteLength"),
        ),
        sessionId: event.sessionId,
      });
      const screenVersion = event.payload.screenVersion;
      if (typeof screenVersion === "number" && Number.isSafeInteger(screenVersion)) {
        await this.#pool.query(
          `UPDATE sessions SET screen_version = GREATEST(screen_version, $3), updated_at = now()
            WHERE id = $1 AND current_generation = $2`,
          [event.sessionId, event.sessionGeneration, screenVersion],
        );
      }
      return;
    }
    await this.#transaction(async (client) => insertEvents(client, [event]));
  }

  public async queryEvents(
    sessionId: string,
    generation: number,
    after: number,
    limit: number,
  ): Promise<EventPage> {
    const page = await this.#observation.queryEvents({ after, generation, limit, sessionId });
    const events = page.events.map((event) => ({
      id: event.id,
      observedAt: event.createdAt,
      payload: event.payload,
      sequence: event.sequence,
      sessionGeneration: event.generation,
      sessionId: event.sessionId,
      type: event.type,
      ...(event.actionId === undefined ? {} : { actionId: event.actionId }),
      ...(event.actor === undefined
        ? {}
        : { actor: { ...event.actor, type: actorType(event.actor.type) } }),
      ...(event.executionId === undefined ? {} : { executionId: event.executionId }),
    }));
    const last = events.at(-1);
    return {
      events,
      truncated: page.truncated,
      ...(page.truncated && last !== undefined ? { nextAfter: last.sequence } : {}),
    };
  }

  public async recoverOwner(
    ownerId: string,
    reason: string,
  ): Promise<{ readonly brokenSessions: number; readonly unknownExecutions: number }> {
    return this.#transaction(async (client) => {
      const executions = await client.query<{ id: string }>(
        `UPDATE executions
            SET status = 'UNKNOWN', unknown_reason = $2, finished_at = now(), version = version + 1
          WHERE owner_id = $1 AND status IN ('DISPATCHING', 'RUNNING')
        RETURNING id`,
        [ownerId, reason],
      );
      await client.query(
        `UPDATE actions a SET status = 'UNKNOWN', updated_at = now()
          FROM executions e
         WHERE e.action_id = a.id AND e.owner_id = $1 AND e.status = 'UNKNOWN'`,
        [ownerId],
      );
      await client.query(
        `UPDATE actions a SET status = 'UNKNOWN', updated_at = now()
          FROM sessions s
         WHERE a.session_id = s.id AND s.owner_id = $1 AND a.status = 'ACCEPTED'`,
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
        await insertEvents(client, [
          {
            id: `evt_recovery_${randomUUID()}`,
            observedAt: new Date().toISOString(),
            payload: { reason },
            sessionGeneration: session.current_generation,
            sessionId: session.id,
            type: "session.broken",
          },
        ]);
      }
      return {
        brokenSessions: sessions.rowCount ?? 0,
        unknownExecutions: executions.rowCount ?? 0,
      };
    });
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

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeError("INVALID_REQUEST", `${name} must be a positive integer`, {
      [name]: value,
    });
  }
  return value;
}

async function insertEvents(
  client: PoolClient,
  events: readonly DurableSessionEvent[],
): Promise<void> {
  for (const event of events) {
    if (event.actor !== undefined) {
      await client.query(
        `INSERT INTO actors (id, actor_type, principal, client)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET actor_type = EXCLUDED.actor_type,
               principal = EXCLUDED.principal,
               client = EXCLUDED.client`,
        [event.actor.id, event.actor.type, event.actor.principal, event.actor.client],
      );
    }
    const sequence = await nextEventSequence(client, event.sessionId, event.sessionGeneration);
    await client.query(
      `INSERT INTO session_events
        (id, session_id, session_generation, event_sequence, event_type,
         action_id, execution_id, actor_id, payload, created_at, search_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        event.id,
        event.sessionId,
        event.sessionGeneration,
        sequence,
        event.type,
        event.actionId ?? null,
        event.executionId ?? null,
        event.actor?.id ?? null,
        JSON.stringify(event.payload),
        event.observedAt,
        eventSearchText(event),
      ],
    );
  }
}

async function nextEventSequence(
  client: PoolClient,
  sessionId: string,
  generation: number,
): Promise<number> {
  const result = await client.query<{ next_event_sequence: string }>(
    `UPDATE session_generations SET next_event_sequence = next_event_sequence + 1
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

async function upsertActor(client: PoolClient, action: SessionAction): Promise<void> {
  await client.query(
    `INSERT INTO actors (id, actor_type, principal, client)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET actor_type = EXCLUDED.actor_type,
           principal = EXCLUDED.principal,
           client = EXCLUDED.client`,
    [action.actor.id, action.actor.type, action.actor.principal, action.actor.client],
  );
}

async function findReplay(
  client: PoolClient,
  sessionId: string,
  actorId: string,
  idempotencyKey: string,
): Promise<
  | {
      readonly actionId: string;
      readonly actionSequence: number;
      readonly executionId: string;
      readonly requestHash: string;
    }
  | undefined
> {
  const result = await client.query<{
    action_sequence: string;
    execution_id: string | null;
    id: string;
    request_hash: string;
  }>(
    `SELECT a.id, a.request_hash, a.action_sequence, e.id AS execution_id
       FROM actions a LEFT JOIN executions e ON e.action_id = a.id
      WHERE a.session_id = $1 AND a.actor_id = $2 AND a.idempotency_key = $3`,
    [sessionId, actorId, idempotencyKey],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    actionId: row.id,
    actionSequence: Number.parseInt(row.action_sequence, 10),
    executionId: row.execution_id ?? "",
    requestHash: row.request_hash,
  };
}

async function expectOne(
  client: PoolClient,
  query: string,
  values: readonly unknown[],
  message: string,
): Promise<void> {
  const result = await client.query(query, [...values]);
  if (result.rowCount !== 1) {
    throw new RuntimeError("DELIVERY_UNKNOWN", message);
  }
}

async function upsertSnapshot(
  client: PoolClient,
  session: Session,
  execution: Execution,
): Promise<void> {
  await client.query(
    `INSERT INTO session_snapshots
      (session_id, session_generation, cwd, active_execution_id, screen_version,
       confidence, observed_at, payload)
     VALUES ($1, $2, $3, NULL, $4, 'observed', $5, $6)
     ON CONFLICT (session_id, session_generation) DO UPDATE
       SET cwd = EXCLUDED.cwd,
           active_execution_id = NULL,
           screen_version = EXCLUDED.screen_version,
           confidence = EXCLUDED.confidence,
           observed_at = EXCLUDED.observed_at,
           payload = EXCLUDED.payload
     WHERE session_snapshots.observed_at <= EXCLUDED.observed_at`,
    [
      session.id,
      session.generation,
      execution.cwd ?? null,
      session.screenVersion,
      execution.finishedAt,
      JSON.stringify({ exitCode: execution.exitCode }),
    ],
  );
}

function actionPayload(action: InputAction | ControlAction): Readonly<Record<string, unknown>> {
  return action.type === "input"
    ? {
        data: action.data,
        targetExecutionId: action.targetExecutionId,
        ...(action.expectedScreenVersion === undefined
          ? {}
          : { expectedScreenVersion: action.expectedScreenVersion }),
      }
    : { delivery: action.delivery, targetExecutionId: action.targetExecutionId };
}

function eventSearchText(event: DurableSessionEvent): string {
  const data = typeof event.payload.data === "string" ? event.payload.data : "";
  return `${event.type} ${data}`;
}

function actorType(value: string): ActorType {
  if (value === "human" || value === "agent" || value === "scheduler" || value === "system") {
    return value;
  }
  throw new RuntimeError("RUNTIME_UNAVAILABLE", `Durable Event has invalid Actor type: ${value}`);
}
