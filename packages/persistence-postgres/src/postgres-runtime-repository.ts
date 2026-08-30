import { randomUUID } from "node:crypto";

import type { SessionFence } from "@iterminal/application";
import type { Actor, Approval, ApprovalStatus, SessionStatus, ShellKind } from "@iterminal/domain";
import { RuntimeError } from "@iterminal/domain";
import type { Pool, PoolClient } from "pg";

import { migrateDatabase } from "./migrate.js";
import { createPostgresEndpointPool, type PostgresConnectionTarget } from "./postgres-endpoints.js";
import { assertSessionFence, throwSessionLeaseLost } from "./session-fencing.js";
import { actorFromRow, persistActor } from "./actors.js";
import {
  actionRateLimitPolicy,
  type ActionRateLimitOptions,
  type ActionRateLimitPolicy,
  consumeActionRateLimit,
} from "./action-rate-limit.js";

const DEFAULT_MAX_PENDING_OUTBOX = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const OUTBOX_ADMISSION_LOCK = 1_746_883_921;

export interface PostgresRuntimeRepositoryOptions extends ActionRateLimitOptions {
  readonly beforeAcceptExecuteCommit?: () => void;
  readonly idleTransactionTimeoutMilliseconds?: number;
  readonly maxPendingOutbox?: number;
  readonly poolMax?: number;
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
  readonly approvalConsumption?: Readonly<{
    readonly actionRequestHash: string;
    readonly approvalId: string;
    readonly consumedAt: Date;
    readonly eventId: string;
  }>;
}

export interface RequestApprovalTransaction {
  readonly approval: Approval;
  readonly eventId: string;
  readonly fence?: SessionFence;
}

export interface DecideApprovalTransaction {
  readonly approvalId: string;
  readonly approver: Actor;
  readonly decidedAt: Date;
  readonly decision: "approve" | "deny";
  readonly decisionIdempotencyKey: string;
  readonly decisionReason: string;
  readonly decisionRequestHash: string;
  readonly eventId: string;
  readonly expectedVersion: number;
  readonly fence?: SessionFence;
  readonly sessionGeneration: number;
  readonly sessionId: string;
}

export interface ApprovalMutationResult {
  readonly approval: Approval;
  readonly replayed: boolean;
}

export interface AcceptedExecute {
  readonly actionId: string;
  readonly executionId: string;
  readonly actionSequence: number;
  readonly replayed: boolean;
}

const APPROVAL_SELECT = `
  SELECT approval.id, approval.session_id, approval.session_generation,
         approval.operation, approval.action_idempotency_key,
         approval.action_request_hash, approval.command, approval.reason,
         approval.request_idempotency_key, approval.request_hash,
         approval.status, approval.version, approval.requested_at,
         approval.expires_at, approval.decided_at,
         approval.decision_idempotency_key, approval.decision_reason,
         approval.decision_request_hash, approval.consumed_action_id,
         approval.consumed_at,
         requester.id AS requester_actor_id,
         requester.actor_type AS requester_actor_type,
         requester.capabilities AS requester_capabilities,
         requester.client AS requester_client,
         requester.principal AS requester_principal,
         approver.id AS approver_actor_id,
         approver.actor_type AS approver_actor_type,
         approver.capabilities AS approver_capabilities,
         approver.client AS approver_client,
         approver.principal AS approver_principal
    FROM approvals approval
    JOIN actors requester ON requester.id = approval.requester_actor_id
    LEFT JOIN actors approver ON approver.id = approval.approver_actor_id`;

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

interface ApprovalRow {
  readonly action_idempotency_key: string;
  readonly action_request_hash: string;
  readonly approver_actor_id: string | null;
  readonly approver_actor_type: string | null;
  readonly approver_capabilities: string[] | null;
  readonly approver_client: string | null;
  readonly approver_principal: string | null;
  readonly command: string;
  readonly consumed_action_id: string | null;
  readonly consumed_at: Date | null;
  readonly decided_at: Date | null;
  readonly decision_idempotency_key: string | null;
  readonly decision_reason: string | null;
  readonly decision_request_hash: string | null;
  readonly expires_at: Date;
  readonly id: string;
  readonly operation: string;
  readonly reason: string;
  readonly request_hash: string;
  readonly request_idempotency_key: string;
  readonly requested_at: Date;
  readonly requester_actor_id: string;
  readonly requester_actor_type: string;
  readonly requester_capabilities: string[];
  readonly requester_client: string;
  readonly requester_principal: string;
  readonly session_generation: number;
  readonly session_id: string;
  readonly status: string;
  readonly version: number;
}

export class PostgresRuntimeRepository {
  readonly #pool: Pool;
  readonly #actionRateLimits: ActionRateLimitPolicy;
  readonly #beforeAcceptExecuteCommit: (() => void) | undefined;
  readonly #maxPendingOutbox: number;
  readonly #requireSessionFence: boolean;

  public constructor(
    connectionString: PostgresConnectionTarget,
    options: PostgresRuntimeRepositoryOptions = {},
  ) {
    this.#actionRateLimits = actionRateLimitPolicy(options);
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
    const idleTransactionTimeoutMilliseconds = positiveInteger(
      options.idleTransactionTimeoutMilliseconds ?? statementTimeoutMilliseconds,
      "idleTransactionTimeoutMilliseconds",
    );
    const poolMax = positiveInteger(options.poolMax ?? 20, "poolMax");
    this.#pool = createPostgresEndpointPool(connectionString, {
      connectionTimeoutMillis: 5_000,
      idle_in_transaction_session_timeout: idleTransactionTimeoutMilliseconds,
      max: poolMax,
      query_timeout: statementTimeoutMilliseconds,
      statement_timeout: statementTimeoutMilliseconds,
    }).pool;
  }

  public async migrate(): Promise<void> {
    await migrateDatabase(this.#pool);
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }

  public async healthCheck(): Promise<void> {
    await this.#pool.query("SELECT 1");
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

  public async requestApproval(input: RequestApprovalTransaction): Promise<ApprovalMutationResult> {
    return this.#transaction(async (client) => {
      await assertApprovalMutationFence(
        client,
        input.approval.sessionId,
        input.approval.sessionGeneration,
        input.fence,
        this.#requireSessionFence,
      );
      await persistActor(client, input.approval.requester);
      const existing = await selectApprovalByRequestKey(
        client,
        input.approval.sessionId,
        input.approval.requester.id,
        input.approval.requestIdempotencyKey,
        true,
      );
      if (existing !== undefined) {
        if (existing.requestHash !== input.approval.requestHash) {
          throw new RuntimeError(
            "IDEMPOTENCY_KEY_REUSED",
            "Approval request idempotency key changed proposal",
            { approvalId: existing.id },
          );
        }
        return { approval: existing, replayed: true };
      }
      const ttlMilliseconds =
        new Date(input.approval.expiresAt).getTime() -
        new Date(input.approval.requestedAt).getTime();
      await client.query(
        `INSERT INTO approvals
          (id, session_id, session_generation, operation, requester_actor_id,
           action_idempotency_key, action_request_hash, command, reason,
           request_idempotency_key, request_hash, status, version, requested_at, expires_at)
         VALUES ($1, $2, $3, 'execution.start', $4, $5, $6, $7, $8, $9, $10,
                 'PENDING', 1, now(), now() + ($11::bigint * interval '1 millisecond'))`,
        [
          input.approval.id,
          input.approval.sessionId,
          input.approval.sessionGeneration,
          input.approval.requester.id,
          input.approval.actionIdempotencyKey,
          input.approval.actionRequestHash,
          input.approval.command,
          input.approval.reason,
          input.approval.requestIdempotencyKey,
          input.approval.requestHash,
          ttlMilliseconds,
        ],
      );
      const persisted = await selectApprovalById(
        client,
        input.approval.sessionId,
        input.approval.sessionGeneration,
        input.approval.id,
        false,
      );
      if (persisted === undefined) {
        throw new RuntimeError("RUNTIME_UNAVAILABLE", "Requested Approval disappeared");
      }
      await insertApprovalEvent(client, {
        actorId: input.approval.requester.id,
        createdAt: persisted.requestedAt,
        eventId: input.eventId,
        eventType: "approval.requested",
        generation: input.approval.sessionGeneration,
        payload: {
          actionRequestHash: input.approval.actionRequestHash,
          approvalId: input.approval.id,
          expiresAt: persisted.expiresAt,
          operation: input.approval.operation,
          reason: input.approval.reason,
        },
        sessionId: input.approval.sessionId,
      });
      return { approval: persisted, replayed: false };
    });
  }

  public async getApproval(
    sessionId: string,
    generation: number,
    approvalId: string,
  ): Promise<Approval> {
    return this.#transaction(async (client) => {
      await expireApprovals(client, sessionId, generation, approvalId);
      const approval = await selectApprovalById(client, sessionId, generation, approvalId, false);
      if (approval === undefined) throw approvalNotFound(approvalId, sessionId, generation);
      return approval;
    });
  }

  public async listApprovals(sessionId: string, generation: number): Promise<readonly Approval[]> {
    return this.#transaction(async (client) => {
      await expireApprovals(client, sessionId, generation);
      const result = await client.query<ApprovalRow>(
        `${APPROVAL_SELECT}
          WHERE approval.session_id = $1 AND approval.session_generation = $2
          ORDER BY approval.requested_at DESC, approval.id DESC
          LIMIT 100`,
        [sessionId, generation],
      );
      return result.rows.map(approvalFromRow);
    });
  }

  public async decideApproval(input: DecideApprovalTransaction): Promise<ApprovalMutationResult> {
    const result = await this.#transaction(async (client) => {
      await assertApprovalMutationFence(
        client,
        input.sessionId,
        input.sessionGeneration,
        input.fence,
        this.#requireSessionFence,
      );
      await persistActor(client, input.approver);
      const current = await selectApprovalById(
        client,
        input.sessionId,
        input.sessionGeneration,
        input.approvalId,
        true,
      );
      if (current === undefined) {
        throw approvalNotFound(input.approvalId, input.sessionId, input.sessionGeneration);
      }
      const expired = await expireLockedApproval(client, current);
      if (expired !== undefined) return { approval: expired, kind: "expired" as const };
      if (current.decisionIdempotencyKey !== undefined) {
        if (
          current.decisionIdempotencyKey === input.decisionIdempotencyKey &&
          current.decisionRequestHash === input.decisionRequestHash
        ) {
          return { approval: current, kind: "replay" as const };
        }
        throw new RuntimeError(
          "IDEMPOTENCY_KEY_REUSED",
          "Approval already has a different decision",
          { approvalId: current.id },
        );
      }
      if (current.version !== input.expectedVersion || current.status !== "PENDING") {
        throw approvalChanged(current, input.expectedVersion);
      }
      const status = input.decision === "approve" ? "APPROVED" : "DENIED";
      await client.query(
        `UPDATE approvals
            SET status = $2, version = version + 1, approver_actor_id = $3,
                decided_at = $4, decision_idempotency_key = $5,
                decision_reason = $6, decision_request_hash = $7
          WHERE id = $1`,
        [
          input.approvalId,
          status,
          input.approver.id,
          input.decidedAt,
          input.decisionIdempotencyKey,
          input.decisionReason,
          input.decisionRequestHash,
        ],
      );
      await insertApprovalEvent(client, {
        actorId: input.approver.id,
        createdAt: input.decidedAt.toISOString(),
        eventId: input.eventId,
        eventType: input.decision === "approve" ? "approval.approved" : "approval.denied",
        generation: input.sessionGeneration,
        payload: {
          approvalId: input.approvalId,
          decisionReason: input.decisionReason,
          expiresAt: current.expiresAt,
          operation: current.operation,
          version: current.version + 1,
        },
        sessionId: input.sessionId,
      });
      const updated = await selectApprovalById(
        client,
        input.sessionId,
        input.sessionGeneration,
        input.approvalId,
        false,
      );
      if (updated === undefined) {
        throw new RuntimeError("RUNTIME_UNAVAILABLE", "Decided Approval disappeared");
      }
      return { approval: updated, kind: "updated" as const };
    });
    if (result.kind === "expired") throw approvalChanged(result.approval);
    return { approval: result.approval, replayed: result.kind === "replay" };
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
      await persistActor(client, input.actor);
      if (input.approvalConsumption !== undefined) {
        await assertApprovalConsumable(client, input);
      }
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

      const sequence = Number.parseInt(reservation.next_action_sequence, 10);
      if (input.expectedActionSequence !== undefined && sequence !== input.expectedActionSequence) {
        throw new RuntimeError("DELIVERY_UNKNOWN", "Live and durable Action sequence diverged", {
          durableActionSequence: sequence,
          liveActionSequence: input.expectedActionSequence,
        });
      }
      await consumeActionRateLimit(client, this.#actionRateLimits, input.actor.id, input.sessionId);
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
          JSON.stringify({
            command: input.command,
            ...(input.approvalConsumption === undefined
              ? {}
              : { approvalId: input.approvalConsumption.approvalId }),
          }),
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
      if (input.approvalConsumption !== undefined) {
        const consumed = await client.query<{ version: number }>(
          `UPDATE approvals
              SET status = 'CONSUMED', version = version + 1,
                  consumed_action_id = $2, consumed_at = $3
            WHERE id = $1 AND session_id = $4 AND session_generation = $5
              AND requester_actor_id = $6 AND action_request_hash = $7
              AND status = 'APPROVED' AND expires_at > now()
          RETURNING version`,
          [
            input.approvalConsumption.approvalId,
            input.actionId,
            input.approvalConsumption.consumedAt,
            input.sessionId,
            input.generation,
            input.actor.id,
            input.approvalConsumption.actionRequestHash,
          ],
        );
        const version = consumed.rows[0]?.version;
        if (version === undefined) {
          throw new RuntimeError(
            "APPROVAL_REQUIRED",
            "Execute Approval is no longer consumable",
            { approvalId: input.approvalConsumption.approvalId },
            true,
          );
        }
        await insertApprovalEvent(client, {
          actionId: input.actionId,
          actorId: input.actor.id,
          createdAt: input.approvalConsumption.consumedAt.toISOString(),
          eventId: input.approvalConsumption.eventId,
          eventType: "approval.consumed",
          generation: input.generation,
          payload: {
            actionId: input.actionId,
            approvalId: input.approvalConsumption.approvalId,
            operation: "execution.start",
            version,
          },
          sessionId: input.sessionId,
        });
      }
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
      await client.query(
        `UPDATE sensitive_inputs sensitive
            SET status = 'UNKNOWN', version = sensitive.version + 1, finished_at = now()
           FROM sessions session
          WHERE sensitive.session_id = session.id AND session.owner_id = $1
            AND sensitive.status = 'ACTIVE'`,
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

async function selectApprovalById(
  client: PoolClient,
  sessionId: string,
  generation: number,
  approvalId: string,
  forUpdate: boolean,
): Promise<Approval | undefined> {
  const result = await client.query<ApprovalRow>(
    `${APPROVAL_SELECT}
      WHERE approval.id = $1 AND approval.session_id = $2
        AND approval.session_generation = $3
      ${forUpdate ? "FOR UPDATE OF approval" : ""}`,
    [approvalId, sessionId, generation],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : approvalFromRow(row);
}

async function selectApprovalByRequestKey(
  client: PoolClient,
  sessionId: string,
  requesterActorId: string,
  requestIdempotencyKey: string,
  forUpdate: boolean,
): Promise<Approval | undefined> {
  const result = await client.query<ApprovalRow>(
    `${APPROVAL_SELECT}
      WHERE approval.session_id = $1 AND approval.requester_actor_id = $2
        AND approval.request_idempotency_key = $3
      ${forUpdate ? "FOR UPDATE OF approval" : ""}`,
    [sessionId, requesterActorId, requestIdempotencyKey],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : approvalFromRow(row);
}

function approvalFromRow(row: ApprovalRow): Approval {
  if (row.operation !== "execution.start" || !isApprovalStatus(row.status)) {
    throw new RuntimeError("RUNTIME_UNAVAILABLE", "Durable Approval state is invalid", {
      approvalId: row.id,
      operation: row.operation,
      status: row.status,
    });
  }
  const requester = actorFromRow({
    actor_id: row.requester_actor_id,
    actor_type: row.requester_actor_type,
    capabilities: row.requester_capabilities,
    client: row.requester_client,
    principal: row.requester_principal,
  });
  let approver: Actor | undefined;
  if (row.approver_actor_id !== null) {
    if (
      row.approver_actor_type === null ||
      row.approver_capabilities === null ||
      row.approver_client === null ||
      row.approver_principal === null
    ) {
      throw new RuntimeError("RUNTIME_UNAVAILABLE", "Durable Approval approver is incomplete", {
        approvalId: row.id,
      });
    }
    approver = actorFromRow({
      actor_id: row.approver_actor_id,
      actor_type: row.approver_actor_type,
      capabilities: row.approver_capabilities,
      client: row.approver_client,
      principal: row.approver_principal,
    });
  }
  return {
    actionIdempotencyKey: row.action_idempotency_key,
    actionRequestHash: row.action_request_hash,
    command: row.command,
    expiresAt: row.expires_at.toISOString(),
    id: row.id,
    operation: row.operation,
    reason: row.reason,
    requestHash: row.request_hash,
    requestIdempotencyKey: row.request_idempotency_key,
    requestedAt: row.requested_at.toISOString(),
    requester,
    sessionGeneration: row.session_generation,
    sessionId: row.session_id,
    status: row.status,
    version: row.version,
    ...(approver === undefined ? {} : { approver }),
    ...(row.consumed_action_id === null ? {} : { consumedActionId: row.consumed_action_id }),
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at.toISOString() }),
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at.toISOString() }),
    ...(row.decision_idempotency_key === null
      ? {}
      : { decisionIdempotencyKey: row.decision_idempotency_key }),
    ...(row.decision_reason === null ? {} : { decisionReason: row.decision_reason }),
    ...(row.decision_request_hash === null
      ? {}
      : { decisionRequestHash: row.decision_request_hash }),
  };
}

function isApprovalStatus(value: string): value is ApprovalStatus {
  return (
    value === "PENDING" ||
    value === "APPROVED" ||
    value === "DENIED" ||
    value === "EXPIRED" ||
    value === "CONSUMED"
  );
}

async function expireApprovals(
  client: PoolClient,
  sessionId: string,
  generation: number,
  approvalId?: string,
): Promise<void> {
  const result = await client.query<{
    expires_at: Date;
    id: string;
    requester_actor_id: string;
    version: number;
  }>(
    `UPDATE approvals
        SET status = 'EXPIRED', version = version + 1
      WHERE session_id = $1 AND session_generation = $2
        AND status IN ('PENDING', 'APPROVED') AND expires_at <= now()
        AND ($3::text IS NULL OR id = $3)
    RETURNING id, requester_actor_id, expires_at, version`,
    [sessionId, generation, approvalId ?? null],
  );
  for (const expired of result.rows) {
    await insertApprovalEvent(client, {
      actorId: expired.requester_actor_id,
      createdAt: new Date().toISOString(),
      eventId: `evt_approval_expired_${randomUUID()}`,
      eventType: "approval.expired",
      generation,
      payload: {
        approvalId: expired.id,
        expiresAt: expired.expires_at.toISOString(),
        operation: "execution.start",
        version: expired.version,
      },
      sessionId,
    });
  }
}

async function expireLockedApproval(
  client: PoolClient,
  approval: Approval,
): Promise<Approval | undefined> {
  if (approval.status !== "PENDING" && approval.status !== "APPROVED") return undefined;
  const result = await client.query<{
    expires_at: Date;
    requester_actor_id: string;
    version: number;
  }>(
    `UPDATE approvals
        SET status = 'EXPIRED', version = version + 1
      WHERE id = $1 AND status IN ('PENDING', 'APPROVED') AND expires_at <= now()
    RETURNING requester_actor_id, expires_at, version`,
    [approval.id],
  );
  const expired = result.rows[0];
  if (expired === undefined) return undefined;
  await insertApprovalEvent(client, {
    actorId: expired.requester_actor_id,
    createdAt: new Date().toISOString(),
    eventId: `evt_approval_expired_${randomUUID()}`,
    eventType: "approval.expired",
    generation: approval.sessionGeneration,
    payload: {
      approvalId: approval.id,
      expiresAt: expired.expires_at.toISOString(),
      operation: approval.operation,
      version: expired.version,
    },
    sessionId: approval.sessionId,
  });
  return selectApprovalById(
    client,
    approval.sessionId,
    approval.sessionGeneration,
    approval.id,
    false,
  );
}

async function assertApprovalConsumable(
  client: PoolClient,
  input: AcceptExecuteTransaction,
): Promise<void> {
  const consumption = input.approvalConsumption;
  if (consumption === undefined) return;
  const result = await client.query<{
    action_request_hash: string;
    active: boolean;
    requester_actor_id: string;
    status: string;
  }>(
    `SELECT action_request_hash, requester_actor_id, status, expires_at > now() AS active
       FROM approvals
      WHERE id = $1 AND session_id = $2 AND session_generation = $3
      FOR UPDATE`,
    [consumption.approvalId, input.sessionId, input.generation],
  );
  const approval = result.rows[0];
  if (approval === undefined) {
    throw approvalNotFound(consumption.approvalId, input.sessionId, input.generation);
  }
  if (
    approval.status !== "APPROVED" ||
    !approval.active ||
    approval.requester_actor_id !== input.actor.id ||
    approval.action_request_hash !== consumption.actionRequestHash
  ) {
    throw new RuntimeError(
      "APPROVAL_REQUIRED",
      "Execute Approval is not valid for this exact proposed action",
      { approvalId: consumption.approvalId, status: approval.status },
      true,
    );
  }
}

async function insertApprovalEvent(
  client: PoolClient,
  input: Readonly<{
    actionId?: string;
    actorId: string;
    createdAt: string | Date;
    eventId: string;
    eventType: string;
    generation: number;
    payload: Readonly<Record<string, unknown>>;
    sessionId: string;
  }>,
): Promise<void> {
  const sequence = await nextEventSequence(client, input.sessionId, input.generation);
  await client.query(
    `INSERT INTO session_events
      (id, session_id, session_generation, event_sequence, event_type,
       action_id, actor_id, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.eventId,
      input.sessionId,
      input.generation,
      sequence,
      input.eventType,
      input.actionId ?? null,
      input.actorId,
      JSON.stringify(input.payload),
      input.createdAt,
    ],
  );
}

async function assertApprovalMutationFence(
  client: PoolClient,
  sessionId: string,
  generation: number,
  fence: SessionFence | undefined,
  requireSessionFence: boolean,
): Promise<void> {
  if (fence === undefined) {
    if (requireSessionFence) {
      throw new RuntimeError(
        "SESSION_LEASE_LOST",
        "Approval mutation requires an explicit Session fence",
        { generation, sessionId },
        false,
      );
    }
    return;
  }
  if (fence.sessionId !== sessionId || fence.generation !== generation) {
    throwSessionLeaseLost(fence);
  }
  await assertSessionFence(client, fence);
}

function approvalNotFound(approvalId: string, sessionId: string, generation: number): RuntimeError {
  return new RuntimeError("APPROVAL_NOT_FOUND", "Approval not found", {
    approvalId,
    generation,
    sessionId,
  });
}

function approvalChanged(approval: Approval, expectedVersion?: number): RuntimeError {
  return new RuntimeError(
    "APPROVAL_CHANGED",
    "Approval state changed",
    {
      approvalId: approval.id,
      currentStatus: approval.status,
      currentVersion: approval.version,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    },
    true,
  );
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
