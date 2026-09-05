CREATE TABLE IF NOT EXISTS action_history_tombstones (
  session_id text NOT NULL,
  session_generation integer NOT NULL,
  actor_id text NOT NULL REFERENCES actors(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  action_id text NOT NULL UNIQUE,
  action_kind text NOT NULL
    CHECK (action_kind IN ('execute', 'input', 'secret_input', 'control', 'resize')),
  action_status text NOT NULL CHECK (action_status IN (
    'COMPLETED', 'FAILED', 'INTERRUPTED', 'UNKNOWN',
    'DELIVERED', 'REJECTED', 'CANCELLED'
  )),
  accepted_at timestamptz NOT NULL,
  execution_id text UNIQUE,
  execution_status text CHECK (
    execution_status IS NULL
    OR execution_status IN ('COMPLETED', 'FAILED', 'INTERRUPTED', 'UNKNOWN')
  ),
  execution_started_at timestamptz,
  execution_finished_at timestamptz,
  execution_exit_code integer,
  compacted_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, actor_id, idempotency_key),
  FOREIGN KEY (session_id, session_generation)
    REFERENCES session_generations(session_id, generation),
  CHECK (
    (action_kind = 'execute' AND execution_id IS NOT NULL AND execution_status IS NOT NULL)
    OR
    (action_kind <> 'execute' AND execution_id IS NULL AND execution_status IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS action_history_tombstones_scope_idx
  ON action_history_tombstones (session_id, session_generation, actor_id);

INSERT INTO schema_migrations (version)
VALUES (20)
ON CONFLICT (version) DO NOTHING;
