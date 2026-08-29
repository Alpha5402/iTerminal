ALTER TABLE session_events
  ADD COLUMN IF NOT EXISTS search_text text NOT NULL DEFAULT '';

UPDATE session_events
   SET search_text = event_type || ' ' || payload::text
 WHERE search_text = '';

CREATE INDEX IF NOT EXISTS session_events_search_idx
  ON session_events USING gin (to_tsvector('simple', search_text));

CREATE INDEX IF NOT EXISTS session_events_time_idx
  ON session_events (session_id, session_generation, created_at, event_sequence);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  session_generation integer NOT NULL,
  execution_id text REFERENCES executions(id),
  kind text NOT NULL,
  content bytea NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (session_id, session_generation)
    REFERENCES session_generations(session_id, generation) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS artifacts_expiry_idx ON artifacts (expires_at);

INSERT INTO schema_migrations (version)
VALUES (2)
ON CONFLICT (version) DO NOTHING;
