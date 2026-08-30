ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS terminal_columns integer NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS terminal_rows integer NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS geometry_version bigint NOT NULL DEFAULT 1;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_terminal_columns_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_terminal_columns_check
  CHECK (terminal_columns BETWEEN 40 AND 240);

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_terminal_rows_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_terminal_rows_check
  CHECK (terminal_rows BETWEEN 12 AND 100);

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_geometry_version_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_geometry_version_check
  CHECK (geometry_version > 0);

ALTER TABLE actions DROP CONSTRAINT IF EXISTS actions_kind_check;
ALTER TABLE actions
  ADD CONSTRAINT actions_kind_check
  CHECK (kind IN ('execute', 'input', 'control', 'resize'));

INSERT INTO schema_migrations (version)
VALUES (5)
ON CONFLICT (version) DO NOTHING;
