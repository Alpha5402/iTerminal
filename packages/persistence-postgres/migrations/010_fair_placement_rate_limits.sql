ALTER TABLE runtime_workers
  ADD COLUMN IF NOT EXISTS placement_count bigint NOT NULL DEFAULT 0;

ALTER TABLE runtime_workers DROP CONSTRAINT IF EXISTS runtime_workers_placement_count_check;
ALTER TABLE runtime_workers
  ADD CONSTRAINT runtime_workers_placement_count_check
  CHECK (placement_count >= 0);

UPDATE runtime_workers worker
   SET placement_count = (
     SELECT count(*)
       FROM sessions session
      WHERE session.owner_id = worker.owner_id
   )
 WHERE placement_count = 0;

CREATE TABLE IF NOT EXISTS actor_action_rate_limit_buckets (
  actor_id text PRIMARY KEY REFERENCES actors(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL,
  action_count bigint NOT NULL CHECK (action_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_action_rate_limit_buckets (
  session_id text PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL,
  action_count bigint NOT NULL CHECK (action_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version)
VALUES (10)
ON CONFLICT (version) DO NOTHING;
