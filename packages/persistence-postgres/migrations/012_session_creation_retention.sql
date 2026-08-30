ALTER TABLE session_creation_requests
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

UPDATE session_creation_requests
   SET completed_at = updated_at
 WHERE session_id IS NOT NULL AND completed_at IS NULL;

ALTER TABLE session_creation_requests
  DROP CONSTRAINT IF EXISTS session_creation_requests_completion_check;
ALTER TABLE session_creation_requests
  ADD CONSTRAINT session_creation_requests_completion_check
  CHECK ((session_id IS NULL) = (completed_at IS NULL));

CREATE INDEX IF NOT EXISTS session_creation_requests_unfinished_retention_idx
  ON session_creation_requests (created_at, idempotency_key)
  WHERE session_id IS NULL;

CREATE INDEX IF NOT EXISTS session_creation_requests_completed_retention_idx
  ON session_creation_requests (completed_at, idempotency_key)
  WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS session_creation_policies (
  scope text PRIMARY KEY CHECK (scope = 'default'),
  retention_milliseconds bigint NOT NULL
    CHECK (retention_milliseconds > 0 AND retention_milliseconds <= 31536000000),
  max_requests bigint NOT NULL
    CHECK (max_requests > 0 AND max_requests <= 10000000),
  cleanup_batch_size integer NOT NULL
    CHECK (cleanup_batch_size > 0 AND cleanup_batch_size <= 10000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO session_creation_policies
  (scope, retention_milliseconds, max_requests, cleanup_batch_size)
VALUES ('default', 86400000, 100000, 1000)
ON CONFLICT (scope) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES (12)
ON CONFLICT (version) DO NOTHING;
