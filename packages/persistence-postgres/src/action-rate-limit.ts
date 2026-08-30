import { RuntimeError } from "@iterminal/domain";
import type { PoolClient } from "pg";

export interface ActionRateLimitOptions {
  readonly actionRateLimitWindowMilliseconds?: number;
  readonly actorActionRateLimit?: number;
  readonly sessionActionRateLimit?: number;
}

export interface ActionRateLimitPolicy {
  readonly actorLimit: number;
  readonly sessionLimit: number;
  readonly windowMilliseconds: number;
}

const DEFAULT_ACTOR_LIMIT = 120;
const DEFAULT_SESSION_LIMIT = 240;
const DEFAULT_WINDOW_MILLISECONDS = 1_000;

export function actionRateLimitPolicy(options: ActionRateLimitOptions = {}): ActionRateLimitPolicy {
  return {
    actorLimit: positiveInteger(options.actorActionRateLimit ?? DEFAULT_ACTOR_LIMIT, "actorLimit"),
    sessionLimit: positiveInteger(
      options.sessionActionRateLimit ?? DEFAULT_SESSION_LIMIT,
      "sessionLimit",
    ),
    windowMilliseconds: positiveInteger(
      options.actionRateLimitWindowMilliseconds ?? DEFAULT_WINDOW_MILLISECONDS,
      "windowMilliseconds",
    ),
  };
}

export async function consumeActionRateLimit(
  client: PoolClient,
  policy: ActionRateLimitPolicy,
  actorId: string,
  sessionId: string,
): Promise<void> {
  validateSubjectId(actorId, "actorId");
  validateSubjectId(sessionId, "sessionId");
  await consumeBucket(client, policy, "actor", actorId, policy.actorLimit);
  await consumeBucket(client, policy, "session", sessionId, policy.sessionLimit);
}

async function consumeBucket(
  client: PoolClient,
  policy: ActionRateLimitPolicy,
  subjectKind: "actor" | "session",
  subjectId: string,
  limit: number,
): Promise<void> {
  const table =
    subjectKind === "actor"
      ? "actor_action_rate_limit_buckets"
      : "session_action_rate_limit_buckets";
  const idColumn = subjectKind === "actor" ? "actor_id" : "session_id";
  const result = await client.query<{
    action_count: string;
    database_now: Date;
    window_started_at: Date;
  }>(
    `INSERT INTO ${table}
       (${idColumn}, window_started_at, action_count, updated_at)
     VALUES ($1, now(), 1, now())
     ON CONFLICT (${idColumn}) DO UPDATE
       SET window_started_at = CASE
             WHEN ${table}.window_started_at
                    + ($2::bigint * interval '1 millisecond') <= now()
               THEN now()
             ELSE ${table}.window_started_at
           END,
           action_count = CASE
             WHEN ${table}.window_started_at
                    + ($2::bigint * interval '1 millisecond') <= now()
               THEN 1
             ELSE ${table}.action_count + 1
           END,
           updated_at = now()
     RETURNING action_count::text, window_started_at, now() AS database_now`,
    [subjectId, policy.windowMilliseconds],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new RuntimeError("RUNTIME_UNAVAILABLE", "Action rate-limit counter was not returned");
  }
  const count = Number.parseInt(row.action_count, 10);
  if (count <= limit) return;
  const retryAfterMilliseconds = Math.max(
    1,
    Math.ceil(
      row.window_started_at.getTime() + policy.windowMilliseconds - row.database_now.getTime(),
    ),
  );
  throw new RuntimeError(
    "RATE_LIMITED",
    `${subjectKind === "actor" ? "Actor" : "Session"} Action rate limit exceeded`,
    {
      limit,
      retryAfterMilliseconds,
      subjectId,
      subjectKind,
      windowMilliseconds: policy.windowMilliseconds,
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

function validateSubjectId(value: string, name: string): void {
  const bytes = Buffer.byteLength(value);
  if (bytes < 1 || bytes > 256 || value.includes("\0")) {
    throw new RuntimeError("INVALID_REQUEST", `${name} must contain 1 to 256 non-NUL bytes`);
  }
}
