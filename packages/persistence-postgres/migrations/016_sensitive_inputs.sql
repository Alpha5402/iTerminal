ALTER TABLE actions DROP CONSTRAINT IF EXISTS actions_kind_check;
ALTER TABLE actions
  ADD CONSTRAINT actions_kind_check
  CHECK (kind IN ('execute', 'input', 'secret_input', 'control', 'resize'));

CREATE TABLE IF NOT EXISTS sensitive_inputs (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  session_generation integer NOT NULL,
  action_id text NOT NULL UNIQUE REFERENCES actions(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES actors(id),
  target_execution_id text NOT NULL REFERENCES executions(id),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED', 'UNKNOWN')),
  version integer NOT NULL CHECK (version > 0),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  finish_idempotency_key text,
  finish_request_hash text,
  FOREIGN KEY (session_id, session_generation)
    REFERENCES session_generations(session_id, generation) ON DELETE CASCADE,
  CHECK (
    (status = 'ACTIVE' AND finished_at IS NULL AND finish_idempotency_key IS NULL AND finish_request_hash IS NULL)
    OR
    (status <> 'ACTIVE' AND finished_at IS NOT NULL)
  ),
  CHECK (finish_request_hash IS NULL OR length(finish_request_hash) = 64)
);

CREATE UNIQUE INDEX IF NOT EXISTS sensitive_inputs_one_active_generation_idx
  ON sensitive_inputs (session_id, session_generation)
  WHERE status = 'ACTIVE';

INSERT INTO schema_migrations (version)
VALUES (16)
ON CONFLICT (version) DO NOTHING;
