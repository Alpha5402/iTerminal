CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  current_generation integer NOT NULL CHECK (current_generation > 0),
  status text NOT NULL CHECK (status IN ('STARTING', 'READY', 'RESERVED', 'RUNNING', 'BROKEN', 'CLOSED')),
  shell text NOT NULL CHECK (shell IN ('bash', 'zsh')),
  workspace_root text NOT NULL,
  owner_id text NOT NULL,
  active_execution_id text,
  next_action_sequence bigint NOT NULL DEFAULT 0,
  screen_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_generations (
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 0),
  owner_id text NOT NULL,
  shell_pid integer,
  integration_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('STARTING', 'READY', 'RESERVED', 'RUNNING', 'BROKEN', 'CLOSED')),
  next_event_sequence bigint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL,
  broken_at timestamptz,
  broken_reason text,
  closed_at timestamptz,
  PRIMARY KEY (session_id, generation)
);

CREATE TABLE IF NOT EXISTS actors (
  id text PRIMARY KEY,
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'agent', 'scheduler', 'system')),
  principal text NOT NULL,
  client text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS actions (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_generation integer NOT NULL,
  actor_id text NOT NULL REFERENCES actors(id),
  kind text NOT NULL CHECK (kind IN ('execute', 'input', 'control')),
  action_sequence bigint NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL,
  accepted_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, action_sequence),
  UNIQUE (session_id, actor_id, idempotency_key),
  FOREIGN KEY (session_id, session_generation)
    REFERENCES session_generations(session_id, generation)
);

CREATE TABLE IF NOT EXISTS executions (
  id text PRIMARY KEY,
  action_id text NOT NULL UNIQUE REFERENCES actions(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  session_generation integer NOT NULL,
  owner_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('DISPATCHING', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'UNKNOWN')),
  command text NOT NULL,
  exit_code integer,
  cwd text,
  started_at timestamptz,
  finished_at timestamptz,
  unknown_reason text,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (session_id, session_generation)
    REFERENCES session_generations(session_id, generation)
);

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_active_execution_fk;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_active_execution_fk
  FOREIGN KEY (active_execution_id) REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS session_events (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  session_generation integer NOT NULL,
  event_sequence bigint NOT NULL,
  event_type text NOT NULL,
  action_id text REFERENCES actions(id),
  execution_id text REFERENCES executions(id),
  actor_id text REFERENCES actors(id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (session_id, session_generation, event_sequence),
  FOREIGN KEY (session_id, session_generation)
    REFERENCES session_generations(session_id, generation) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS session_events_execution_idx
  ON session_events (execution_id, event_sequence);
CREATE INDEX IF NOT EXISTS session_events_type_idx
  ON session_events (session_id, session_generation, event_type, event_sequence);

CREATE TABLE IF NOT EXISTS session_snapshots (
  session_id text NOT NULL,
  session_generation integer NOT NULL,
  cwd text,
  active_execution_id text,
  screen_version bigint NOT NULL DEFAULT 0,
  confidence text NOT NULL,
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (session_id, session_generation),
  FOREIGN KEY (session_id, session_generation)
    REFERENCES session_generations(session_id, generation) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shell_checkpoints (
  session_id text NOT NULL,
  source_generation integer NOT NULL,
  checkpoint_version integer NOT NULL,
  cwd text NOT NULL,
  shell text NOT NULL,
  filtered_env jsonb NOT NULL,
  content_hash text NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, source_generation),
  FOREIGN KEY (session_id, source_generation)
    REFERENCES session_generations(session_id, generation) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS outbox (
  id text PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS retention_policies (
  scope text PRIMARY KEY,
  max_age_days integer NOT NULL CHECK (max_age_days > 0),
  max_events_per_generation integer NOT NULL CHECK (max_events_per_generation > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO retention_policies (scope, max_age_days, max_events_per_generation)
VALUES ('default', 7, 100000)
ON CONFLICT (scope) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES (1)
ON CONFLICT (version) DO NOTHING;
