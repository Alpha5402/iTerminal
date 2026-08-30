CREATE SEQUENCE IF NOT EXISTS session_fencing_token_seq
  AS bigint MINVALUE 1 NO CYCLE;

CREATE TABLE IF NOT EXISTS session_leases (
  session_id text NOT NULL,
  session_generation integer NOT NULL CHECK (session_generation > 0),
  owner_id text NOT NULL,
  owner_instance_id text NOT NULL,
  owner_registry_epoch bigint NOT NULL CHECK (owner_registry_epoch > 0),
  fencing_token bigint NOT NULL DEFAULT nextval('session_fencing_token_seq')
    CHECK (fencing_token > 0),
  acquired_at timestamptz NOT NULL,
  renewed_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  released_at timestamptz,
  release_reason text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (session_id, session_generation),
  UNIQUE (fencing_token),
  FOREIGN KEY (session_id, session_generation)
    REFERENCES session_generations(session_id, generation) ON DELETE CASCADE,
  CHECK ((released_at IS NULL) = (release_reason IS NULL)),
  CHECK (length(owner_id) BETWEEN 1 AND 256),
  CHECK (length(owner_instance_id) BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS session_leases_owner_active_idx
  ON session_leases (owner_id, owner_instance_id, owner_registry_epoch, lease_expires_at)
  WHERE released_at IS NULL;

INSERT INTO schema_migrations (version)
VALUES (9)
ON CONFLICT (version) DO NOTHING;
