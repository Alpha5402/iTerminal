CREATE TABLE IF NOT EXISTS runtime_workers (
  owner_id text PRIMARY KEY,
  instance_id text NOT NULL,
  registry_epoch bigint NOT NULL CHECK (registry_epoch > 0),
  endpoint text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'DRAINING', 'STOPPED')),
  heartbeat_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL,
  stopped_at timestamptz,
  version bigint NOT NULL CHECK (version > 0),
  CHECK (length(owner_id) BETWEEN 1 AND 256),
  CHECK (length(instance_id) BETWEEN 1 AND 256),
  CHECK (length(endpoint) BETWEEN 1 AND 4096),
  CHECK ((status = 'STOPPED') = (stopped_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS runtime_workers_instance_idx
  ON runtime_workers (instance_id);

CREATE INDEX IF NOT EXISTS runtime_workers_assignable_idx
  ON runtime_workers (lease_expires_at, owner_id)
  WHERE status = 'ACTIVE';

INSERT INTO schema_migrations (version)
VALUES (7)
ON CONFLICT (version) DO NOTHING;
