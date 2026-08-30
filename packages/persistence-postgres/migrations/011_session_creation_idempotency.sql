CREATE TABLE IF NOT EXISTS session_creation_requests (
  idempotency_key text PRIMARY KEY,
  request_hash text NOT NULL,
  owner_id text NOT NULL REFERENCES runtime_workers(owner_id),
  owner_instance_id text NOT NULL,
  owner_registry_epoch bigint NOT NULL CHECK (owner_registry_epoch > 0),
  session_id text UNIQUE REFERENCES sessions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_creation_requests_owner_idx
  ON session_creation_requests (owner_id, owner_instance_id, owner_registry_epoch);

INSERT INTO schema_migrations (version)
VALUES (11)
ON CONFLICT (version) DO NOTHING;
