import { RuntimeError } from "@iterminal/domain";
import type { PoolClient } from "pg";

const SESSION_PLACEMENT_ADVISORY_LOCK = 1_769_238_389;

export interface SessionCreationPolicy {
  readonly cleanupBatchSize: number;
  readonly maxRequests: number;
  readonly retentionMilliseconds: number;
}

export async function lockSessionPlacement(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [SESSION_PLACEMENT_ADVISORY_LOCK]);
}

export async function prepareSessionCreationAdmission(
  client: PoolClient,
): Promise<SessionCreationPolicy> {
  await lockSessionPlacement(client);
  const policyResult = await client.query<{
    cleanup_batch_size: number;
    max_requests: string;
    retention_milliseconds: string;
  }>(
    `SELECT cleanup_batch_size, max_requests::text, retention_milliseconds::text
       FROM session_creation_policies
      WHERE scope = 'default'
      FOR SHARE`,
  );
  const row = policyResult.rows[0];
  if (row === undefined) {
    throw new RuntimeError(
      "RUNTIME_UNAVAILABLE",
      "Session creation retention policy is unavailable",
      { component: "persistence-postgres", operation: "session.create" },
      true,
    );
  }
  const policy: SessionCreationPolicy = {
    cleanupBatchSize: positiveSafeInteger(row.cleanup_batch_size, "cleanupBatchSize"),
    maxRequests: positiveSafeInteger(row.max_requests, "maxRequests"),
    retentionMilliseconds: positiveSafeInteger(row.retention_milliseconds, "retentionMilliseconds"),
  };
  await client.query(
    `WITH candidates AS (
       SELECT request.idempotency_key
         FROM session_creation_requests AS request
        WHERE
          (
            request.session_id IS NULL
            AND request.created_at
                  + ($1::bigint * interval '1 millisecond') <= now()
            AND NOT EXISTS (
              SELECT 1
                FROM runtime_workers AS worker
               WHERE worker.owner_id = request.owner_id
                 AND worker.instance_id = request.owner_instance_id
                 AND worker.registry_epoch = request.owner_registry_epoch
                 AND worker.status IN ('ACTIVE', 'DRAINING')
                 AND worker.lease_expires_at > now()
            )
          )
          OR
          (
            request.session_id IS NOT NULL
            AND request.completed_at IS NOT NULL
            AND request.completed_at
                  + ($1::bigint * interval '1 millisecond') <= now()
            AND EXISTS (
              SELECT 1
                FROM sessions AS session
               WHERE session.id = request.session_id
                 AND session.status IN ('BROKEN', 'CLOSED')
            )
          )
        ORDER BY COALESCE(request.completed_at, request.created_at), request.idempotency_key
        LIMIT $2
        FOR UPDATE OF request SKIP LOCKED
     )
     DELETE FROM session_creation_requests AS request
      USING candidates
      WHERE request.idempotency_key = candidates.idempotency_key`,
    [policy.retentionMilliseconds, policy.cleanupBatchSize],
  );
  return policy;
}

export async function assertSessionCreationCapacity(
  client: PoolClient,
  policy: SessionCreationPolicy,
): Promise<void> {
  const occupancy = await client.query<{ request_count: string }>(
    "SELECT count(*)::text AS request_count FROM session_creation_requests",
  );
  const requestCount = positiveOrZeroSafeInteger(occupancy.rows[0]?.request_count, "requestCount");
  if (requestCount < policy.maxRequests) return;
  throw new RuntimeError(
    "BACKPRESSURE",
    "Session creation idempotency capacity is exhausted",
    {
      component: "persistence-postgres",
      currentRequests: requestCount,
      limit: policy.maxRequests,
      operation: "session.create",
      phase: "idempotency_admission",
    },
    true,
  );
}

function positiveSafeInteger(value: number | string, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw invalidPolicy(name, value);
  }
  return parsed;
}

function positiveOrZeroSafeInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalidPolicy(name, value);
  }
  return parsed;
}

function invalidPolicy(name: string, value: unknown): RuntimeError {
  return new RuntimeError(
    "RUNTIME_UNAVAILABLE",
    "Session creation retention policy contains an invalid value",
    { component: "persistence-postgres", name, value },
  );
}
