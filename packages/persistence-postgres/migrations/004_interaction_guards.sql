CREATE TABLE IF NOT EXISTS interaction_guards (
  session_id text NOT NULL,
  session_generation integer NOT NULL CHECK (session_generation > 0),
  input_policy text NOT NULL CHECK (
    input_policy IN ('common', 'human_guarded', 'human_only', 'agent_only')
  ),
  state_version bigint NOT NULL CHECK (state_version > 0),
  guard_id text,
  guard_actor_id text REFERENCES actors(id),
  guard_reason text,
  guard_acquired_at timestamptz,
  guard_expires_at timestamptz,
  guard_renewals integer NOT NULL DEFAULT 0 CHECK (guard_renewals >= 0),
  guard_max_renewals integer NOT NULL DEFAULT 3 CHECK (guard_max_renewals >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, session_generation),
  FOREIGN KEY (session_id, session_generation)
    REFERENCES session_generations(session_id, generation) ON DELETE CASCADE,
  CHECK (
    (
      guard_id IS NULL
      AND guard_actor_id IS NULL
      AND guard_reason IS NULL
      AND guard_acquired_at IS NULL
      AND guard_expires_at IS NULL
      AND guard_renewals = 0
    )
    OR
    (
      guard_id IS NOT NULL
      AND guard_actor_id IS NOT NULL
      AND guard_reason IS NOT NULL
      AND length(guard_reason) BETWEEN 1 AND 256
      AND guard_acquired_at IS NOT NULL
      AND guard_expires_at IS NOT NULL
      AND guard_expires_at > guard_acquired_at
      AND guard_renewals <= guard_max_renewals
    )
  )
);

INSERT INTO interaction_guards
  (session_id, session_generation, input_policy, state_version)
SELECT id, current_generation, 'human_guarded', 1
  FROM sessions
ON CONFLICT (session_id, session_generation) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES (4)
ON CONFLICT (version) DO NOTHING;
