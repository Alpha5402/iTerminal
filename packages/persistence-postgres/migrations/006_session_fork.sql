ALTER TABLE shell_checkpoints
  ADD COLUMN IF NOT EXISTS workspace_root text;

UPDATE shell_checkpoints c
   SET workspace_root = s.workspace_root
  FROM sessions s
 WHERE s.id = c.session_id
   AND c.workspace_root IS NULL;

ALTER TABLE shell_checkpoints
  ALTER COLUMN workspace_root SET NOT NULL;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS parent_session_id text REFERENCES sessions(id),
  ADD COLUMN IF NOT EXISTS parent_generation integer,
  ADD COLUMN IF NOT EXISTS source_checkpoint_version integer,
  ADD COLUMN IF NOT EXISTS source_checkpoint_hash text,
  ADD COLUMN IF NOT EXISTS forked_at timestamptz;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_fork_lineage_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_fork_lineage_check CHECK (
    (parent_session_id IS NULL
      AND parent_generation IS NULL
      AND source_checkpoint_version IS NULL
      AND source_checkpoint_hash IS NULL
      AND forked_at IS NULL)
    OR
    (parent_session_id IS NOT NULL
      AND parent_generation > 0
      AND source_checkpoint_version > 0
      AND length(source_checkpoint_hash) = 64
      AND forked_at IS NOT NULL)
  );

CREATE TABLE IF NOT EXISTS session_forks (
  id text PRIMARY KEY,
  parent_session_id text NOT NULL REFERENCES sessions(id),
  parent_generation integer NOT NULL,
  actor_id text NOT NULL REFERENCES actors(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  child_session_id text NOT NULL UNIQUE REFERENCES sessions(id),
  checkpoint_version integer NOT NULL CHECK (checkpoint_version > 0),
  checkpoint_hash text NOT NULL CHECK (length(checkpoint_hash) = 64),
  stale boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('STARTING', 'READY', 'FAILED')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_session_id, actor_id, idempotency_key),
  FOREIGN KEY (parent_session_id, parent_generation)
    REFERENCES session_generations(session_id, generation)
);

CREATE INDEX IF NOT EXISTS session_forks_parent_idx
  ON session_forks (parent_session_id, parent_generation, created_at);

INSERT INTO schema_migrations (version)
VALUES (6)
ON CONFLICT (version) DO NOTHING;
