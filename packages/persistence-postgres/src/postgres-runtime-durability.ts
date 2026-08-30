import { randomUUID } from "node:crypto";

import type {
  DurableExecuteAdmission,
  DurableExecuteAdmissionResult,
  DurableForkAdmission,
  DurableOwnerRecoveryResult,
  DurableRebuildableSession,
  DurableSessionEvent,
  RuntimeOwnerIdentity,
  RuntimeDurability,
  SessionFence,
  SessionLease,
} from "@iterminal/application";
import type {
  Actor,
  ControlAction,
  ActorType,
  EventPage,
  Execution,
  InputAction,
  InputPolicyMode,
  InteractionState,
  ResizeAction,
  Session,
  SessionAction,
  SessionStatus,
  ShellCheckpoint,
} from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";
import type { Pool, PoolClient } from "pg";

import { PostgresObservationRepository } from "./postgres-observation-repository.js";
import {
  createPostgresEndpointPool,
  type PostgresConnectionTarget,
  type PostgresEndpointPool,
} from "./postgres-endpoints.js";
import {
  assertSessionCreationCapacity,
  prepareSessionCreationAdmission,
} from "./session-creation-retention.js";
import { PostgresRuntimeRepository } from "./postgres-runtime-repository.js";
import {
  actionRateLimitPolicy,
  type ActionRateLimitOptions,
  type ActionRateLimitPolicy,
  consumeActionRateLimit,
} from "./action-rate-limit.js";
import {
  assertRuntimeOwner,
  assertSessionFence,
  createSessionLease,
  releaseSessionLease,
  sessionLease,
  type SessionLeaseRow,
  throwSessionLeaseLost,
} from "./session-fencing.js";

export interface PostgresRuntimeDurabilityOptions extends ActionRateLimitOptions {
  readonly beforeAcceptExecuteCommit?: () => void;
  readonly idleTransactionTimeoutMilliseconds?: number;
  readonly maxPendingOutbox?: number;
  readonly poolMax?: number;
  readonly statementTimeoutMilliseconds?: number;
}

const MAX_REBUILDABLE_SESSIONS = 100;

interface SessionCreationIntentRow {
  readonly owner_id: string;
  readonly owner_instance_id: string;
  readonly owner_registry_epoch: string;
  readonly request_hash: string;
  readonly session_id: string | null;
}

export class PostgresRuntimeDurability implements RuntimeDurability {
  readonly #pool: Pool;
  readonly #endpoints: PostgresEndpointPool;
  readonly #actionRateLimits: ActionRateLimitPolicy;
  readonly #observation: PostgresObservationRepository;
  readonly #admission: PostgresRuntimeRepository;

  public constructor(
    connectionString: PostgresConnectionTarget,
    options: PostgresRuntimeDurabilityOptions = {},
  ) {
    this.#actionRateLimits = actionRateLimitPolicy(options);
    const statementTimeoutMilliseconds = positiveInteger(
      options.statementTimeoutMilliseconds ?? 30_000,
      "statementTimeoutMilliseconds",
    );
    const idleTransactionTimeoutMilliseconds = positiveInteger(
      options.idleTransactionTimeoutMilliseconds ?? statementTimeoutMilliseconds,
      "idleTransactionTimeoutMilliseconds",
    );
    const poolMax = positiveInteger(options.poolMax ?? 20, "poolMax");
    this.#endpoints = createPostgresEndpointPool(connectionString, {
      connectionTimeoutMillis: 5_000,
      idle_in_transaction_session_timeout: idleTransactionTimeoutMilliseconds,
      max: poolMax,
      query_timeout: statementTimeoutMilliseconds,
      statement_timeout: statementTimeoutMilliseconds,
    });
    this.#pool = this.#endpoints.pool;
    this.#observation = new PostgresObservationRepository(connectionString, {
      idleTransactionTimeoutMilliseconds,
      ...(options.poolMax === undefined ? {} : { poolMax: options.poolMax }),
      requireSessionFence: true,
    });
    this.#admission = new PostgresRuntimeRepository(connectionString, {
      ...options,
      requireSessionFence: true,
    });
  }

  public async migrate(): Promise<void> {
    await this.#admission.migrate();
  }

  public async healthCheck(): Promise<void> {
    await Promise.all([
      this.#pool.query("SELECT 1"),
      this.#observation.healthCheck(),
      this.#admission.healthCheck(),
    ]);
  }

  public databaseEndpointIndex(): number {
    return this.#endpoints.endpointIndex();
  }

  public async close(): Promise<void> {
    await Promise.all([this.#pool.end(), this.#observation.close(), this.#admission.close()]);
  }

  public async createSession(
    session: Session,
    events: readonly DurableSessionEvent[],
    owner: RuntimeOwnerIdentity,
    leaseMilliseconds: number,
    creation: { readonly idempotencyKey: string; readonly requestHash: string },
  ): Promise<
    | { readonly kind: "created"; readonly lease: SessionLease }
    | { readonly kind: "replay"; readonly sessionId: string }
  > {
    return this.#transaction(async (client) => {
      assertSessionOwner(session, owner);
      await assertRuntimeOwner(client, owner);
      const readIntent = (): Promise<{ readonly rows: SessionCreationIntentRow[] }> =>
        client.query<SessionCreationIntentRow>(
          `SELECT request_hash, owner_id, owner_instance_id,
                  owner_registry_epoch::text, session_id
             FROM session_creation_requests
            WHERE idempotency_key = $1
            FOR UPDATE`,
          [creation.idempotencyKey],
        );
      let existing = (await readIntent()).rows[0];
      if (existing === undefined) {
        const creationPolicy = await prepareSessionCreationAdmission(client);
        existing = (await readIntent()).rows[0];
        if (existing === undefined) {
          await assertSessionCreationCapacity(client, creationPolicy);
          await client.query(
            `INSERT INTO session_creation_requests
              (idempotency_key, request_hash, owner_id, owner_instance_id, owner_registry_epoch)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              creation.idempotencyKey,
              creation.requestHash,
              owner.ownerId,
              owner.instanceId,
              owner.epoch,
            ],
          );
        }
      }
      if (existing !== undefined) {
        if (
          existing.request_hash !== creation.requestHash ||
          existing.owner_id !== owner.ownerId ||
          existing.owner_instance_id !== owner.instanceId ||
          Number.parseInt(existing.owner_registry_epoch, 10) !== owner.epoch
        ) {
          throw new RuntimeError(
            "IDEMPOTENCY_KEY_REUSED",
            "Session creation idempotency key changed request or exact owner",
            { idempotencyKey: creation.idempotencyKey },
          );
        }
        if (existing.session_id !== null) {
          return { kind: "replay", sessionId: existing.session_id };
        }
      }
      await client.query(
        `INSERT INTO sessions
          (id, current_generation, status, shell, workspace_root, owner_id,
           next_action_sequence, screen_version, terminal_columns, terminal_rows,
           geometry_version, created_at)
         VALUES ($1, $2, 'STARTING', $3, $4, $5, $6, $7, 120, 40, 1, $8)`,
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
      await client.query(
        `INSERT INTO interaction_guards
          (session_id, session_generation, input_policy, state_version)
         VALUES ($1, $2, 'human_guarded', 1)`,
        [session.id, session.generation],
      );
      const lease = await createSessionLease(client, {
        generation: session.generation,
        leaseMilliseconds,
        owner,
        sessionId: session.id,
      });
      await insertEvents(client, events);
      await expectOne(
        client,
        `UPDATE session_creation_requests
            SET session_id = $2, completed_at = now(), updated_at = now()
          WHERE idempotency_key = $1 AND session_id IS NULL`,
        [creation.idempotencyKey, session.id],
        "Session was committed without binding its creation idempotency key",
      );
      return { kind: "created", lease };
    });
  }

  public async renewSessionLeases(
    owner: RuntimeOwnerIdentity,
    leases: readonly SessionFence[],
    leaseMilliseconds: number,
  ): Promise<readonly SessionLease[]> {
    positiveInteger(leaseMilliseconds, "leaseMilliseconds");
    if (leases.length === 0) {
      await this.#transaction((client) => assertRuntimeOwner(client, owner));
      return [];
    }
    return this.#transaction(async (client) => {
      const currentOwner = await assertRuntimeOwner(client, owner);
      for (const lease of leases) {
        if (
          lease.ownerId !== owner.ownerId ||
          lease.instanceId !== owner.instanceId ||
          lease.epoch !== owner.epoch
        ) {
          throwSessionLeaseLost(lease);
        }
      }
      const requested = leases.map((lease) => ({
        fencingToken: lease.fencingToken,
        generation: lease.generation,
        sessionId: lease.sessionId,
      }));
      const renewed = await client.query<{
        acquired_at: Date;
        fencing_token: string;
        lease_expires_at: Date;
        owner_id: string;
        owner_instance_id: string;
        owner_registry_epoch: string;
        renewed_at: Date;
        session_generation: number;
        session_id: string;
        version: string;
      }>(
        `WITH requested AS (
           SELECT * FROM jsonb_to_recordset($4::jsonb)
             AS item(session_id text, generation integer, fencing_token bigint)
         )
         UPDATE session_leases lease
            SET renewed_at = now(),
                lease_expires_at = LEAST(
                  $5::timestamptz,
                  now() + ($6::bigint * interval '1 millisecond')
                ),
                version = lease.version + 1
           FROM requested
          WHERE lease.session_id = requested.session_id
            AND lease.session_generation = requested.generation
            AND lease.fencing_token = requested.fencing_token
            AND lease.owner_id = $1 AND lease.owner_instance_id = $2
            AND lease.owner_registry_epoch = $3
            AND lease.released_at IS NULL AND lease.lease_expires_at > now()
         RETURNING lease.session_id, lease.session_generation, lease.owner_id,
                   lease.owner_instance_id, lease.owner_registry_epoch::text,
                   lease.fencing_token::text, lease.acquired_at, lease.renewed_at,
                   lease.lease_expires_at, lease.version::text`,
        [
          owner.ownerId,
          owner.instanceId,
          owner.epoch,
          JSON.stringify(
            requested.map((item) => ({
              fencing_token: item.fencingToken,
              generation: item.generation,
              session_id: item.sessionId,
            })),
          ),
          currentOwner.leaseExpiresAt,
          leaseMilliseconds,
        ],
      );
      if (renewed.rows.length !== leases.length) throwSessionLeaseLost(leases[0] as SessionFence);
      const byScope = new Map(
        renewed.rows.map((row) => [
          `${row.session_id}:${row.session_generation.toString()}:${row.fencing_token}`,
          sessionLease(row),
        ]),
      );
      return leases.map((lease) => {
        const renewedLease = byScope.get(
          `${lease.sessionId}:${lease.generation.toString()}:${lease.fencingToken}`,
        );
        if (renewedLease === undefined) throwSessionLeaseLost(lease);
        return renewedLease;
      });
    });
  }

  public async markSessionReady(
    fence: SessionFence,
    session: Session,
    shellPid: number,
    event: DurableSessionEvent,
    checkpoint: ShellCheckpoint,
    additionalEvents: readonly DurableSessionEvent[] = [],
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await assertSessionFence(client, fence);
      assertFenceSession(fence, session);
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
      await upsertCheckpoint(client, checkpoint);
      await client.query(
        `UPDATE session_forks SET status = 'READY', updated_at = now()
          WHERE child_session_id = $1 AND status = 'STARTING'`,
        [session.id],
      );
      await insertEvents(client, [event, ...additionalEvents]);
    });
  }

  public async createForkSession(
    input: DurableForkAdmission,
    owner: RuntimeOwnerIdentity,
    leaseMilliseconds: number,
    parentFence?: SessionFence,
  ): Promise<SessionLease> {
    return this.#transaction(async (client) => {
      assertSessionOwner(input.child, owner);
      await assertRuntimeOwner(client, owner);
      if (
        input.parent.status === "READY" ||
        input.parent.status === "RESERVED" ||
        input.parent.status === "RUNNING"
      ) {
        if (parentFence === undefined) {
          throw new RuntimeError("SESSION_LEASE_LOST", "Live fork parent has no Session fence", {
            generation: input.parent.generation,
            sessionId: input.parent.id,
          });
        }
        await assertSessionFence(client, parentFence);
        assertFenceSession(parentFence, input.parent);
      }
      const parent = await client.query<{ status: SessionStatus }>(
        `SELECT status
           FROM sessions
          WHERE id = $1 AND current_generation = $2
          FOR UPDATE`,
        [input.parent.id, input.parent.generation],
      );
      const existing = await client.query<{
        child_session_id: string;
        request_hash: string;
      }>(
        `SELECT child_session_id, request_hash
           FROM session_forks
          WHERE parent_session_id = $1 AND actor_id = $2 AND idempotency_key = $3
          FOR UPDATE`,
        [input.parent.id, input.actor.id, input.idempotencyKey],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (replay.request_hash !== input.requestHash) {
          throw new RuntimeError(
            "IDEMPOTENCY_KEY_REUSED",
            "Fork idempotency key was already used with a different request",
            { childSessionId: replay.child_session_id },
          );
        }
        if (replay.child_session_id !== input.child.id) {
          throw new RuntimeError(
            "DELIVERY_UNKNOWN",
            "Durable fork already exists but is not live in this Runtime owner",
            { childSessionId: replay.child_session_id },
          );
        }
        const lease = await selectSessionLease(client, input.child.id, input.child.generation);
        if (lease === undefined) {
          throw new RuntimeError("DELIVERY_UNKNOWN", "Durable fork child has no Session lease", {
            childSessionId: input.child.id,
          });
        }
        await assertSessionFence(client, lease);
        return lease;
      }
      const parentStatus = parent.rows[0]?.status;
      if (parentStatus === undefined || parentStatus !== input.expectedParentStatus) {
        throw new RuntimeError(
          "CHECKPOINT_CHANGED",
          "Parent Session changed before durable fork admission",
          { currentStatus: parentStatus, expectedStatus: input.expectedParentStatus },
          true,
        );
      }
      const sourceCheckpoint = await client.query<{
        checkpoint_version: number;
        content_hash: string;
      }>(
        `SELECT checkpoint_version, content_hash
           FROM shell_checkpoints
          WHERE session_id = $1 AND source_generation = $2
          FOR UPDATE`,
        [input.parent.id, input.parent.generation],
      );
      const durableCheckpoint = sourceCheckpoint.rows[0];
      if (
        durableCheckpoint === undefined ||
        durableCheckpoint.checkpoint_version !== input.expectedCheckpointVersion ||
        durableCheckpoint.content_hash !== input.expectedCheckpointHash
      ) {
        throw new RuntimeError(
          "CHECKPOINT_CHANGED",
          "Durable Shell checkpoint changed before fork admission",
          {
            currentCheckpointHash: durableCheckpoint?.content_hash,
            currentCheckpointVersion: durableCheckpoint?.checkpoint_version,
            expectedCheckpointHash: input.expectedCheckpointHash,
            expectedCheckpointVersion: input.expectedCheckpointVersion,
          },
          true,
        );
      }
      await upsertActor(client, input.actor);
      await consumeActionRateLimit(client, this.#actionRateLimits, input.actor.id, input.parent.id);
      await upsertCheckpoint(client, input.checkpoint);
      await client.query(
        `INSERT INTO sessions
          (id, current_generation, status, shell, workspace_root, owner_id,
           next_action_sequence, screen_version, terminal_columns, terminal_rows,
           geometry_version, created_at, parent_session_id, parent_generation,
           source_checkpoint_version, source_checkpoint_hash, forked_at)
         VALUES ($1, 1, 'STARTING', $2, $3, $4, 0, 0, 120, 40, 1, $5,
                 $6, $7, $8, $9, $10)`,
        [
          input.child.id,
          input.child.shell,
          input.child.workspaceRoot,
          input.child.ownerId,
          input.child.createdAt,
          input.parent.id,
          input.parent.generation,
          input.checkpoint.version,
          input.checkpoint.contentHash,
          input.child.lineage?.forkedAt,
        ],
      );
      await client.query(
        `INSERT INTO session_generations
          (session_id, generation, owner_id, integration_version, status, started_at)
         VALUES ($1, 1, $2, 'runtime-v1', 'STARTING', $3)`,
        [input.child.id, input.child.ownerId, input.child.createdAt],
      );
      const childLease = await createSessionLease(client, {
        generation: input.child.generation,
        leaseMilliseconds,
        owner,
        sessionId: input.child.id,
      });
      await client.query(
        `INSERT INTO interaction_guards
          (session_id, session_generation, input_policy, state_version)
         VALUES ($1, 1, 'human_guarded', 1)`,
        [input.child.id],
      );
      await client.query(
        `INSERT INTO session_forks
          (id, parent_session_id, parent_generation, actor_id, idempotency_key,
           request_hash, child_session_id, checkpoint_version, checkpoint_hash,
           stale, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'STARTING', $11)`,
        [
          `fork_${randomUUID()}`,
          input.parent.id,
          input.parent.generation,
          input.actor.id,
          input.idempotencyKey,
          input.requestHash,
          input.child.id,
          input.checkpoint.version,
          input.checkpoint.contentHash,
          input.expectedParentStatus !== "READY",
          input.child.createdAt,
        ],
      );
      await insertEvents(client, [input.parentEvent, ...input.childEvents]);
      return childLease;
    });
  }

  public async markSessionBroken(
    fence: SessionFence,
    session: Session,
    events: readonly DurableSessionEvent[],
    reason: string,
    activeExecution?: Readonly<{ readonly id: string; readonly version: number }>,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await assertSessionFence(client, fence);
      assertFenceSession(fence, session);
      await markActiveExecutionUnknown(client, session, activeExecution, reason);
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
      await client.query(
        `UPDATE session_forks SET status = 'FAILED', updated_at = now()
          WHERE child_session_id = $1 AND status = 'STARTING'`,
        [session.id],
      );
      await insertEvents(client, events);
      await releaseSessionLease(client, fence, reason);
    });
  }

  public async closeSession(
    fence: SessionFence,
    session: Session,
    event: DurableSessionEvent,
    activeExecution?: Readonly<{ readonly id: string; readonly version: number }>,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await assertSessionFence(client, fence);
      assertFenceSession(fence, session);
      await markActiveExecutionUnknown(
        client,
        session,
        activeExecution,
        "session closed while active",
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
      await releaseSessionLease(client, fence, "session closed");
    });
  }

  public async acceptExecute(
    fence: SessionFence,
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
      fence,
    });
  }

  public async markExecutionRunning(input: {
    readonly fence: SessionFence;
    readonly expectedExecutionVersion: number;
    readonly session: Session;
    readonly action: Extract<SessionAction, { type: "execute" }>;
    readonly execution: Execution;
    readonly event: DurableSessionEvent;
  }): Promise<void> {
    await this.#transaction(async (client) => {
      await assertSessionFence(client, input.fence);
      assertFenceSession(input.fence, input.session);
      await expectOne(
        client,
        `UPDATE executions
            SET status = 'RUNNING', started_at = $2, version = version + 1
          WHERE id = $1 AND status = 'DISPATCHING' AND version = $3
            AND session_id = $4 AND session_generation = $5 AND owner_id = $6`,
        [
          input.execution.id,
          input.execution.startedAt,
          input.expectedExecutionVersion,
          input.session.id,
          input.session.generation,
          input.session.ownerId,
        ],
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
    readonly fence: SessionFence;
    readonly expectedExecutionVersion: number;
    readonly session: Session;
    readonly action: Extract<SessionAction, { type: "execute" }>;
    readonly execution: Execution;
    readonly event: DurableSessionEvent;
  }): Promise<void> {
    await this.#transaction(async (client) => {
      await assertSessionFence(client, input.fence);
      assertFenceSession(input.fence, input.session);
      const execution = await client.query(
        `SELECT 1 FROM executions
          WHERE id = $1 AND session_id = $2 AND session_generation = $3
            AND owner_id = $4 AND status = 'DISPATCHING' AND version = $5
          FOR UPDATE`,
        [
          input.execution.id,
          input.session.id,
          input.session.generation,
          input.session.ownerId,
          input.expectedExecutionVersion,
        ],
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
    readonly fence: SessionFence;
    readonly expectedExecutionVersion: number;
    readonly session: Session;
    readonly action: Extract<SessionAction, { type: "execute" }>;
    readonly execution: Execution;
    readonly events: readonly DurableSessionEvent[];
    readonly checkpoint?: ShellCheckpoint;
  }): Promise<void> {
    await this.#transaction(async (client) => {
      await assertSessionFence(client, input.fence);
      assertFenceSession(input.fence, input.session);
      if (input.execution.status !== "COMPLETED" && input.execution.status !== "INTERRUPTED") {
        throw new RuntimeError("INVALID_REQUEST", "Execution terminal status is invalid");
      }
      await expectOne(
        client,
        `UPDATE executions
            SET status = $2, exit_code = $3, cwd = $4, finished_at = $5, version = version + 1
          WHERE id = $1 AND status IN ('DISPATCHING', 'RUNNING') AND version = $6
            AND session_id = $7 AND session_generation = $8 AND owner_id = $9`,
        [
          input.execution.id,
          input.execution.status,
          input.execution.exitCode,
          input.execution.cwd,
          input.execution.finishedAt,
          input.expectedExecutionVersion,
          input.session.id,
          input.session.generation,
          input.session.ownerId,
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
      if (input.checkpoint !== undefined) await upsertCheckpoint(client, input.checkpoint);
    });
  }

  public async failExecution(input: {
    readonly fence: SessionFence;
    readonly expectedExecutionVersion: number;
    readonly session: Session;
    readonly action: Extract<SessionAction, { type: "execute" }>;
    readonly execution: Execution;
    readonly events: readonly DurableSessionEvent[];
    readonly reason: string;
  }): Promise<void> {
    await this.#transaction(async (client) => {
      await assertSessionFence(client, input.fence);
      assertFenceSession(input.fence, input.session);
      await expectOne(
        client,
        `UPDATE executions
            SET status = 'FAILED', unknown_reason = $2, finished_at = $3, version = version + 1
          WHERE id = $1 AND status IN ('DISPATCHING', 'RUNNING') AND version = $4
            AND session_id = $5 AND session_generation = $6 AND owner_id = $7`,
        [
          input.execution.id,
          input.reason,
          input.execution.finishedAt,
          input.expectedExecutionVersion,
          input.session.id,
          input.session.generation,
          input.session.ownerId,
        ],
        "Execution version changed before failure",
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
      await releaseSessionLease(client, input.fence, input.reason);
    });
  }

  public async saveInteractionState(
    fence: SessionFence,
    state: InteractionState,
    expectedVersion: number,
    event: DurableSessionEvent,
  ): Promise<void> {
    if (state.version !== expectedVersion + 1) {
      throw new RuntimeError(
        "INVALID_REQUEST",
        "Interaction state version must advance exactly once",
        { expectedVersion, nextVersion: state.version },
      );
    }
    await this.#transaction(async (client) => {
      await assertSessionFence(client, fence);
      assertFenceScope(fence, state.sessionId, state.sessionGeneration);
      const current = await client.query(
        `SELECT 1
           FROM interaction_guards AS interaction
           JOIN sessions AS session
             ON session.id = interaction.session_id
            AND session.current_generation = interaction.session_generation
          WHERE interaction.session_id = $1
            AND interaction.session_generation = $2
            AND interaction.state_version = $3
            AND session.status NOT IN ('BROKEN', 'CLOSED')
          FOR UPDATE OF session, interaction`,
        [state.sessionId, state.sessionGeneration, expectedVersion],
      );
      if (current.rowCount !== 1) {
        throw new RuntimeError(
          "INTERACTION_GUARD_CHANGED",
          "Durable Interaction state is no longer current",
          {
            expectedVersion,
            generation: state.sessionGeneration,
            sessionId: state.sessionId,
          },
          true,
        );
      }
      if (event.actor !== undefined) {
        await upsertActor(client, event.actor);
        await consumeActionRateLimit(
          client,
          this.#actionRateLimits,
          event.actor.id,
          state.sessionId,
        );
      }
      if (state.guard !== undefined && state.guard.actor.id !== event.actor?.id) {
        await upsertActor(client, state.guard.actor);
      }
      const updated = await client.query(
        `UPDATE interaction_guards AS interaction
            SET input_policy = $4,
                state_version = $5,
                guard_id = $6,
                guard_actor_id = $7,
                guard_reason = $8,
                guard_acquired_at = $9,
                guard_expires_at = $10,
                guard_renewals = $11,
                guard_max_renewals = $12,
                updated_at = now()
           FROM sessions AS session
          WHERE interaction.session_id = $1
            AND interaction.session_generation = $2
            AND interaction.state_version = $3
            AND session.id = interaction.session_id
            AND session.current_generation = interaction.session_generation
            AND session.status NOT IN ('BROKEN', 'CLOSED')`,
        [
          state.sessionId,
          state.sessionGeneration,
          expectedVersion,
          state.policy,
          state.version,
          state.guard?.id ?? null,
          state.guard?.actor.id ?? null,
          state.guard?.reason ?? null,
          state.guard?.acquiredAt ?? null,
          state.guard?.expiresAt ?? null,
          state.guard?.renewals ?? 0,
          state.guard?.maxRenewals ?? 3,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new RuntimeError(
          "INTERACTION_GUARD_CHANGED",
          "Durable Interaction state is no longer current",
          {
            expectedVersion,
            generation: state.sessionGeneration,
            sessionId: state.sessionId,
          },
          true,
        );
      }
      await insertEvents(client, [event]);
    });
  }

  public async acceptInteraction(
    fence: SessionFence,
    action: InputAction | ControlAction,
    event: DurableSessionEvent,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await assertSessionFence(client, fence);
      assertFenceScope(fence, action.sessionId, action.sessionGeneration);
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
        database_now: Date;
        guard_actor_id: string | null;
        guard_expires_at: Date | null;
        input_policy: InputPolicyMode;
        next_action_sequence: string;
        screen_version: string;
        status: SessionStatus;
      }>(
        `SELECT session.current_generation, session.status, session.active_execution_id,
                session.next_action_sequence, session.screen_version,
                interaction.input_policy, interaction.guard_actor_id,
                interaction.guard_expires_at, now() AS database_now
           FROM sessions AS session
           JOIN interaction_guards AS interaction
             ON interaction.session_id = session.id
            AND interaction.session_generation = session.current_generation
          WHERE session.id = $1
          FOR UPDATE OF session, interaction`,
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
      assertDurableInteractionAllowed(action, current);
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
      await upsertActor(client, action.actor);
      await consumeActionRateLimit(
        client,
        this.#actionRateLimits,
        action.actor.id,
        action.sessionId,
      );
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
    fence: SessionFence,
    action: InputAction | ControlAction,
    event: DurableSessionEvent,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await assertSessionFence(client, fence);
      assertFenceScope(fence, action.sessionId, action.sessionGeneration);
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

  public async acceptResize(
    fence: SessionFence,
    action: ResizeAction,
    event: DurableSessionEvent,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await assertSessionFence(client, fence);
      assertFenceScope(fence, action.sessionId, action.sessionGeneration);
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
            "Resize idempotency key already exists",
            { actionId: replay.actionId },
          );
        }
        return;
      }
      const result = await client.query<{
        current_generation: number;
        database_now: Date;
        geometry_version: string;
        guard_actor_id: string | null;
        guard_expires_at: Date | null;
        input_policy: InputPolicyMode;
        next_action_sequence: string;
        owner_id: string;
        status: SessionStatus;
      }>(
        `SELECT session.current_generation, session.status, session.owner_id,
                session.next_action_sequence, session.geometry_version,
                interaction.input_policy, interaction.guard_actor_id,
                interaction.guard_expires_at, now() AS database_now
           FROM sessions AS session
           JOIN interaction_guards AS interaction
             ON interaction.session_id = session.id
            AND interaction.session_generation = session.current_generation
          WHERE session.id = $1
          FOR UPDATE OF session, interaction`,
        [action.sessionId],
      );
      const current = result.rows[0];
      if (current === undefined) {
        throw new RuntimeError("SESSION_NOT_FOUND", `Session not found: ${action.sessionId}`);
      }
      if (current.current_generation !== action.sessionGeneration) {
        throw new RuntimeError("SESSION_GENERATION_CHANGED", "Session generation changed", {
          currentGeneration: current.current_generation,
        });
      }
      if (current.owner_id !== fence.ownerId) {
        throw new RuntimeError("DELIVERY_UNKNOWN", "Resize reached a stale Runtime owner", {
          currentOwnerId: current.owner_id,
          ownerId: fence.ownerId,
        });
      }
      if (
        current.status !== "READY" &&
        current.status !== "RESERVED" &&
        current.status !== "RUNNING"
      ) {
        throw new RuntimeError("SESSION_NOT_READY", "Session has no resizable live PTY", {
          status: current.status,
        });
      }
      const currentGeometryVersion = Number.parseInt(current.geometry_version, 10);
      if (currentGeometryVersion !== action.expectedGeometryVersion) {
        throw new RuntimeError(
          "GEOMETRY_CHANGED",
          "Expected terminal geometry version is stale",
          {
            currentGeometryVersion,
            expectedGeometryVersion: action.expectedGeometryVersion,
          },
          true,
        );
      }
      assertDurableInteractionAllowed(action, current);
      const durableSequence = Number.parseInt(current.next_action_sequence, 10) + 1;
      if (durableSequence !== action.actionSequence) {
        throw new RuntimeError("DELIVERY_UNKNOWN", "Live and durable Action sequence diverged", {
          durableActionSequence: durableSequence,
          liveActionSequence: action.actionSequence,
        });
      }
      await expectOne(
        client,
        `UPDATE sessions
            SET next_action_sequence = $2, terminal_columns = $3, terminal_rows = $4,
                geometry_version = geometry_version + 1, updated_at = now()
          WHERE id = $1 AND geometry_version = $5`,
        [
          action.sessionId,
          action.actionSequence,
          action.columns,
          action.rows,
          action.expectedGeometryVersion,
        ],
        "Durable terminal geometry version changed",
      );
      await upsertActor(client, action.actor);
      await consumeActionRateLimit(
        client,
        this.#actionRateLimits,
        action.actor.id,
        action.sessionId,
      );
      await client.query(
        `INSERT INTO actions
          (id, session_id, session_generation, actor_id, kind, action_sequence,
           idempotency_key, request_hash, payload, status, accepted_at)
         VALUES ($1, $2, $3, $4, 'resize', $5, $6, $7, $8, 'ACCEPTED', $9)`,
        [
          action.id,
          action.sessionId,
          action.sessionGeneration,
          action.actor.id,
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

  public async markResizeWriteAttempted(
    fence: SessionFence,
    action: ResizeAction,
    event: DurableSessionEvent,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await assertSessionFence(client, fence);
      assertFenceScope(fence, action.sessionId, action.sessionGeneration);
      const current = await client.query(
        `SELECT 1
           FROM actions a
           JOIN sessions s ON s.id = a.session_id
          WHERE a.id = $1 AND a.session_generation = $2 AND a.kind = 'resize'
            AND a.status = 'ACCEPTED'
            AND s.current_generation = $2 AND s.owner_id = $3
            AND s.status IN ('READY', 'RESERVED', 'RUNNING')
          FOR UPDATE OF a, s`,
        [action.id, action.sessionGeneration, fence.ownerId],
      );
      if (current.rowCount !== 1) {
        throw new RuntimeError("DELIVERY_UNKNOWN", "Resize write attempt is no longer current", {
          actionId: action.id,
        });
      }
      await insertEvents(client, [event]);
    });
  }

  public async finishResize(input: {
    readonly fence: SessionFence;
    readonly action: ResizeAction;
    readonly event: DurableSessionEvent;
    readonly session: Session;
    readonly brokenEvent?: DurableSessionEvent;
    readonly activeExecution?: Readonly<{ readonly id: string; readonly version: number }>;
  }): Promise<void> {
    await this.#transaction(async (client) => {
      await assertSessionFence(client, input.fence);
      assertFenceSession(input.fence, input.session);
      await expectOne(
        client,
        `UPDATE actions SET status = $2, updated_at = now()
          WHERE id = $1 AND status = 'ACCEPTED'`,
        [input.action.id, input.action.status],
        "Resize Action did not reach its delivery state",
      );
      if (input.action.status === "DELIVERED") {
        await expectOne(
          client,
          `UPDATE sessions
              SET screen_version = GREATEST(screen_version, $3), updated_at = now()
            WHERE id = $1 AND current_generation = $2
              AND terminal_columns = $4 AND terminal_rows = $5
              AND geometry_version = $6`,
          [
            input.session.id,
            input.session.generation,
            input.session.screenVersion,
            input.action.columns,
            input.action.rows,
            input.action.expectedGeometryVersion + 1,
          ],
          "Durable terminal geometry did not match the delivered resize",
        );
        await insertEvents(client, [input.event]);
        return;
      }
      await markActiveExecutionUnknown(
        client,
        input.session,
        input.activeExecution,
        "terminal geometry convergence is unknown",
      );
      await client.query(
        `UPDATE sessions SET status = 'BROKEN', active_execution_id = NULL, updated_at = now()
          WHERE id = $1 AND current_generation = $2 AND status <> 'CLOSED'`,
        [input.session.id, input.session.generation],
      );
      await client.query(
        `UPDATE session_generations
            SET status = 'BROKEN', broken_at = now(),
                broken_reason = 'terminal geometry convergence is unknown'
          WHERE session_id = $1 AND generation = $2 AND status <> 'CLOSED'`,
        [input.session.id, input.session.generation],
      );
      await insertEvents(
        client,
        input.brokenEvent === undefined ? [input.event] : [input.event, input.brokenEvent],
      );
      await releaseSessionLease(client, input.fence, "terminal geometry convergence is unknown");
    });
  }

  public async markInteractionWriteAttempted(
    fence: SessionFence,
    action: InputAction | ControlAction,
    event: DurableSessionEvent,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await assertSessionFence(client, fence);
      assertFenceScope(fence, action.sessionId, action.sessionGeneration);
      const current = await client.query(
        `SELECT 1
           FROM actions a
           JOIN sessions s ON s.id = a.session_id
          WHERE a.id = $1 AND a.session_generation = $2 AND a.kind = $3
            AND a.status = 'ACCEPTED'
            AND s.current_generation = $2 AND s.owner_id = $4
            AND s.status = 'RUNNING' AND s.active_execution_id = $5
          FOR UPDATE OF a, s`,
        [action.id, action.sessionGeneration, action.type, fence.ownerId, action.targetExecutionId],
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

  public async appendEvent(fence: SessionFence, event: DurableSessionEvent): Promise<void> {
    assertFenceScope(fence, event.sessionId, event.sessionGeneration);
    if (event.type === "terminal.pty_output" && typeof event.payload.data === "string") {
      await this.#observation.appendOutput({
        fence,
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
        await this.#transaction(async (client) => {
          await assertSessionFence(client, fence);
          await client.query(
            `UPDATE sessions SET screen_version = GREATEST(screen_version, $3), updated_at = now()
              WHERE id = $1 AND current_generation = $2`,
            [event.sessionId, event.sessionGeneration, screenVersion],
          );
        });
      }
      return;
    }
    await this.#transaction(async (client) => {
      await assertSessionFence(client, fence);
      await insertEvents(client, [event]);
    });
  }

  public async appendOwnerEvent(
    owner: RuntimeOwnerIdentity,
    event: DurableSessionEvent,
  ): Promise<void> {
    await this.#transaction(async (client) => {
      await assertRuntimeOwner(client, owner);
      const historical = await client.query(
        `SELECT 1 FROM sessions
          WHERE id = $1 AND current_generation = $2 AND owner_id = $3
            AND status = 'BROKEN'
          FOR UPDATE`,
        [event.sessionId, event.sessionGeneration, owner.ownerId],
      );
      if (historical.rowCount !== 1) {
        throw new RuntimeError(
          "SESSION_LEASE_LOST",
          "Owner-authorized Event is restricted to a historical BROKEN Session",
          { generation: event.sessionGeneration, sessionId: event.sessionId },
          false,
        );
      }
      await insertEvents(client, [event]);
    });
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
    owner: RuntimeOwnerIdentity,
    reason: string,
  ): Promise<DurableOwnerRecoveryResult> {
    return this.#transaction(async (client) => {
      await assertRuntimeOwner(client, owner);
      const executions = await client.query<{ id: string }>(
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
        RETURNING execution.id`,
        [owner.ownerId, reason],
      );
      await client.query(
        `UPDATE actions a SET status = 'UNKNOWN', updated_at = now()
          FROM executions e
         WHERE e.action_id = a.id AND e.owner_id = $1 AND e.status = 'UNKNOWN'`,
        [owner.ownerId],
      );
      await client.query(
        `UPDATE actions a SET status = 'UNKNOWN', updated_at = now()
          FROM sessions s
         WHERE a.session_id = s.id AND s.owner_id = $1 AND a.status = 'ACCEPTED'`,
        [owner.ownerId],
      );
      const sessions = await client.query<{ id: string; current_generation: number }>(
        `UPDATE sessions
            SET status = 'BROKEN', active_execution_id = NULL, updated_at = now()
          WHERE owner_id = $1 AND status IN ('STARTING', 'READY', 'RESERVED', 'RUNNING')
        RETURNING id, current_generation`,
        [owner.ownerId],
      );
      await client.query(
        `UPDATE session_generations
            SET status = 'BROKEN', broken_at = now(), broken_reason = $2
          WHERE owner_id = $1 AND status IN ('STARTING', 'READY', 'RESERVED', 'RUNNING')`,
        [owner.ownerId, reason],
      );
      await client.query(
        `UPDATE session_leases
            SET released_at = now(), release_reason = $2, lease_expires_at = now(),
                version = version + 1
          WHERE owner_id = $1 AND released_at IS NULL`,
        [owner.ownerId, reason],
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
      const rebuildable = await client.query<{
        checkpoint_version: number;
        content_hash: string;
        created_at: Date;
        current_generation: number;
        cwd: string;
        filtered_env: unknown;
        forked_at: Date | null;
        next_action_sequence: string;
        next_event_sequence: string;
        observed_at: Date;
        owner_id: string;
        parent_generation: number | null;
        parent_session_id: string | null;
        screen_version: string;
        session_id: string;
        shell: "bash" | "zsh";
        source_checkpoint_hash: string | null;
        source_checkpoint_version: number | null;
        workspace_root: string;
      }>(
        `SELECT s.id AS session_id, s.current_generation, s.shell, s.workspace_root,
                s.owner_id, s.next_action_sequence, s.screen_version, s.created_at,
                s.parent_session_id, s.parent_generation, s.source_checkpoint_version,
                s.source_checkpoint_hash, s.forked_at, g.next_event_sequence,
                c.checkpoint_version, c.cwd, c.filtered_env, c.content_hash, c.observed_at
           FROM sessions s
           JOIN session_generations g
             ON g.session_id = s.id AND g.generation = s.current_generation
           JOIN shell_checkpoints c
             ON c.session_id = s.id AND c.source_generation = s.current_generation
          WHERE s.owner_id = $1 AND s.status = 'BROKEN' AND g.status = 'BROKEN'
          ORDER BY s.updated_at DESC, s.created_at DESC, s.id
          LIMIT $2`,
        [owner.ownerId, MAX_REBUILDABLE_SESSIONS],
      );
      return {
        brokenSessions: sessions.rowCount ?? 0,
        rebuildableSessions: rebuildable.rows.flatMap((row) => {
          const filteredEnvironment = stringRecord(row.filtered_env);
          if (filteredEnvironment === undefined) return [];
          const session: Session = {
            actionSequence: Number.parseInt(row.next_action_sequence, 10),
            createdAt: row.created_at.toISOString(),
            eventSequence: Number.parseInt(row.next_event_sequence, 10),
            generation: row.current_generation,
            id: row.session_id,
            ownerId: row.owner_id,
            screenVersion: Number.parseInt(row.screen_version, 10),
            shell: row.shell,
            status: "BROKEN",
            workspaceRoot: row.workspace_root,
            ...(row.parent_session_id === null ||
            row.parent_generation === null ||
            row.source_checkpoint_version === null ||
            row.source_checkpoint_hash === null ||
            row.forked_at === null
              ? {}
              : {
                  lineage: {
                    checkpointHash: row.source_checkpoint_hash,
                    checkpointVersion: row.source_checkpoint_version,
                    forkedAt: row.forked_at.toISOString(),
                    parentGeneration: row.parent_generation,
                    parentSessionId: row.parent_session_id,
                  },
                }),
          };
          const recovered: DurableRebuildableSession = {
            checkpoint: {
              contentHash: row.content_hash,
              cwd: row.cwd,
              filteredEnvironment,
              observedAt: row.observed_at.toISOString(),
              sessionId: row.session_id,
              shell: row.shell,
              sourceGeneration: row.current_generation,
              version: row.checkpoint_version,
              workspaceRoot: row.workspace_root,
            },
            session,
          };
          return [recovered];
        }),
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

function assertSessionOwner(session: Session, owner: RuntimeOwnerIdentity): void {
  if (session.ownerId !== owner.ownerId) {
    throw new RuntimeError("SESSION_LEASE_LOST", "Session owner does not match Runtime identity", {
      ownerId: owner.ownerId,
      sessionId: session.id,
      sessionOwnerId: session.ownerId,
    });
  }
}

function assertFenceSession(fence: SessionFence, session: Session): void {
  assertFenceScope(fence, session.id, session.generation);
  if (fence.ownerId !== session.ownerId) {
    throwSessionLeaseLost(fence);
  }
}

function assertFenceScope(fence: SessionFence, sessionId: string, generation: number): void {
  if (fence.sessionId !== sessionId || fence.generation !== generation) {
    throwSessionLeaseLost(fence);
  }
}

async function selectSessionLease(
  client: PoolClient,
  sessionId: string,
  generation: number,
): Promise<SessionLease | undefined> {
  const result = await client.query<SessionLeaseRow>(
    `SELECT session_id, session_generation, owner_id, owner_instance_id,
            owner_registry_epoch::text, fencing_token::text, acquired_at,
            renewed_at, lease_expires_at, version::text
       FROM session_leases
      WHERE session_id = $1 AND session_generation = $2`,
    [sessionId, generation],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : sessionLease(row);
}

function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) return undefined;
  return Object.fromEntries(entries);
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

async function upsertActor(client: PoolClient, actor: Actor): Promise<void> {
  await client.query(
    `INSERT INTO actors (id, actor_type, principal, client)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET actor_type = EXCLUDED.actor_type,
           principal = EXCLUDED.principal,
           client = EXCLUDED.client`,
    [actor.id, actor.type, actor.principal, actor.client],
  );
}

function assertDurableInteractionAllowed(
  action: InputAction | ControlAction | ResizeAction,
  state: Readonly<{
    database_now: Date;
    guard_actor_id: string | null;
    guard_expires_at: Date | null;
    input_policy: InputPolicyMode;
  }>,
): void {
  if (action.type === "control" && action.bypassGuard && action.actor.type !== "human") {
    throw new RuntimeError("POLICY_DENIED", "Only Human Control may request Guard bypass", {
      policy: state.input_policy,
    });
  }
  const allowed =
    (state.input_policy === "common" &&
      (action.actor.type === "human" || action.actor.type === "agent")) ||
    (state.input_policy === "human_guarded" &&
      (action.actor.type === "human" || action.actor.type === "agent")) ||
    (state.input_policy === "human_only" && action.actor.type === "human") ||
    (state.input_policy === "agent_only" && action.actor.type === "agent");
  if (!allowed) {
    throw new RuntimeError(
      "POLICY_DENIED",
      `Actor type ${action.actor.type} cannot ${action.type} under ${state.input_policy}`,
      { policy: state.input_policy },
    );
  }
  const guardActive =
    state.input_policy === "human_guarded" &&
    state.guard_actor_id !== null &&
    state.guard_expires_at !== null &&
    state.guard_expires_at.getTime() > state.database_now.getTime();
  if (
    guardActive &&
    state.guard_actor_id !== action.actor.id &&
    !(action.type === "control" && action.bypassGuard && action.actor.type === "human")
  ) {
    throw new RuntimeError(
      "INPUT_GUARDED",
      "Interaction is protected by an active Human Guard",
      {
        expiresAt: state.guard_expires_at?.toISOString(),
        guardActorId: state.guard_actor_id,
        policy: state.input_policy,
      },
      true,
    );
  }
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

async function markActiveExecutionUnknown(
  client: PoolClient,
  session: Pick<Session, "generation" | "id" | "ownerId">,
  expected: Readonly<{ readonly id: string; readonly version: number }> | undefined,
  reason: string,
): Promise<void> {
  const active = await client.query<{
    action_id: string;
    id: string;
    version: number;
  }>(
    `SELECT id, action_id, version
       FROM executions
      WHERE session_id = $1 AND session_generation = $2 AND owner_id = $3
        AND status IN ('DISPATCHING', 'RUNNING')
      FOR UPDATE`,
    [session.id, session.generation, session.ownerId],
  );
  const row = active.rows[0];
  if (active.rows.length > 1) {
    throw new RuntimeError("DELIVERY_UNKNOWN", "Session has multiple active Executions", {
      generation: session.generation,
      sessionId: session.id,
    });
  }
  if (row === undefined && expected === undefined) return;
  if (
    row === undefined ||
    expected === undefined ||
    row.id !== expected.id ||
    row.version !== expected.version
  ) {
    throw new RuntimeError(
      "DELIVERY_UNKNOWN",
      "Active Execution changed before the Session lifecycle transition",
      {
        currentExecutionId: row?.id,
        currentExecutionVersion: row?.version,
        expectedExecutionId: expected?.id,
        expectedExecutionVersion: expected?.version,
        sessionId: session.id,
      },
    );
  }
  await expectOne(
    client,
    `UPDATE executions
        SET status = 'UNKNOWN', unknown_reason = $3, finished_at = now(),
            version = version + 1
      WHERE id = $1 AND version = $2 AND status IN ('DISPATCHING', 'RUNNING')`,
    [row.id, row.version, reason],
    "Execution version changed before it became UNKNOWN",
  );
  await expectOne(
    client,
    `UPDATE actions SET status = 'UNKNOWN', updated_at = now()
      WHERE id = $1 AND status IN ('DISPATCHING', 'RUNNING')`,
    [row.action_id],
    "Execute Action changed before it became UNKNOWN",
  );
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

async function upsertCheckpoint(client: PoolClient, checkpoint: ShellCheckpoint): Promise<void> {
  await client.query(
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
     WHERE shell_checkpoints.checkpoint_version < EXCLUDED.checkpoint_version
        OR (shell_checkpoints.checkpoint_version = EXCLUDED.checkpoint_version
            AND shell_checkpoints.content_hash = EXCLUDED.content_hash
            AND shell_checkpoints.observed_at <= EXCLUDED.observed_at)`,
    [
      checkpoint.sessionId,
      checkpoint.sourceGeneration,
      checkpoint.version,
      checkpoint.cwd,
      checkpoint.shell,
      JSON.stringify(checkpoint.filteredEnvironment),
      checkpoint.contentHash,
      checkpoint.observedAt,
      checkpoint.workspaceRoot,
    ],
  );
}

function actionPayload(
  action: InputAction | ControlAction | ResizeAction,
): Readonly<Record<string, unknown>> {
  if (action.type === "input") {
    return {
      data: action.data,
      targetExecutionId: action.targetExecutionId,
      ...(action.expectedScreenVersion === undefined
        ? {}
        : { expectedScreenVersion: action.expectedScreenVersion }),
    };
  }
  if (action.type === "control") {
    return {
      bypassGuard: action.bypassGuard,
      delivery: action.delivery,
      targetExecutionId: action.targetExecutionId,
    };
  }
  return {
    columns: action.columns,
    expectedGeometryVersion: action.expectedGeometryVersion,
    rows: action.rows,
  };
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
