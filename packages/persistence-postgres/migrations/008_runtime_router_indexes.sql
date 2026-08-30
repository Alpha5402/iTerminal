CREATE INDEX IF NOT EXISTS sessions_live_owner_idx
  ON sessions (owner_id)
  WHERE status IN ('STARTING', 'READY', 'RESERVED', 'RUNNING', 'BROKEN');

INSERT INTO schema_migrations (version)
VALUES (8)
ON CONFLICT (version) DO NOTHING;
