ALTER TABLE artifacts
  DROP CONSTRAINT IF EXISTS artifacts_byte_size_matches_content;
ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_byte_size_matches_content
  CHECK (byte_size = octet_length(content));

CREATE TABLE artifact_storage_policies (
  scope text PRIMARY KEY CHECK (scope = 'default'),
  max_bytes bigint NOT NULL CHECK (max_bytes > 0 AND max_bytes <= 9007199254740991),
  max_artifact_bytes bigint NOT NULL
    CHECK (max_artifact_bytes > 0 AND max_artifact_bytes <= max_bytes),
  retention_milliseconds bigint NOT NULL
    CHECK (retention_milliseconds > 0 AND retention_milliseconds <= 315360000000),
  cleanup_batch_size integer NOT NULL CHECK (cleanup_batch_size BETWEEN 1 AND 100000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO artifact_storage_policies
  (scope, max_bytes, max_artifact_bytes, retention_milliseconds, cleanup_batch_size)
VALUES ('default', 1073741824, 16777216, 604800000, 1000);

CREATE TABLE artifact_storage_usage (
  scope text PRIMARY KEY REFERENCES artifact_storage_policies(scope),
  artifact_count bigint NOT NULL CHECK (artifact_count >= 0),
  byte_size bigint NOT NULL CHECK (byte_size >= 0 AND byte_size <= 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO artifact_storage_usage (scope, artifact_count, byte_size)
SELECT 'default', count(*), coalesce(sum(byte_size), 0)
  FROM artifacts;

CREATE OR REPLACE FUNCTION iterminal_account_artifact_storage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_bytes bigint;
  delta_bytes bigint;
  policy_max_artifact_bytes bigint;
  policy_max_bytes bigint;
BEGIN
  SELECT max_bytes, max_artifact_bytes
    INTO policy_max_bytes, policy_max_artifact_bytes
    FROM public.artifact_storage_policies
   WHERE scope = 'default'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Artifact storage policy is unavailable';
  END IF;

  SELECT byte_size
    INTO current_bytes
    FROM public.artifact_storage_usage
   WHERE scope = 'default'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Artifact storage usage is unavailable';
  END IF;

  delta_bytes := CASE
    WHEN TG_OP = 'INSERT' THEN NEW.byte_size
    ELSE NEW.byte_size - OLD.byte_size
  END;

  IF NEW.byte_size > policy_max_artifact_bytes THEN
    RAISE EXCEPTION 'Artifact exceeds the per-row storage limit'
      USING ERRCODE = '23514', CONSTRAINT = 'artifacts_max_artifact_bytes';
  END IF;

  IF delta_bytes > 0 AND current_bytes > policy_max_bytes - delta_bytes THEN
    RAISE EXCEPTION 'Artifact storage budget is exhausted'
      USING ERRCODE = '23514', CONSTRAINT = 'artifacts_storage_budget';
  END IF;

  UPDATE public.artifact_storage_usage
     SET artifact_count = artifact_count + CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE 0 END,
         byte_size = byte_size + delta_bytes,
         updated_at = now()
   WHERE scope = 'default';
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION iterminal_release_artifact_storage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
    FROM public.artifact_storage_policies
   WHERE scope = 'default'
   FOR UPDATE;

  UPDATE public.artifact_storage_usage
     SET artifact_count = artifact_count - 1,
         byte_size = byte_size - OLD.byte_size,
         updated_at = now()
   WHERE scope = 'default';
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION iterminal_reset_artifact_storage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
    FROM public.artifact_storage_policies
   WHERE scope = 'default'
   FOR UPDATE;

  UPDATE public.artifact_storage_usage
     SET artifact_count = 0, byte_size = 0, updated_at = now()
   WHERE scope = 'default';
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS artifacts_account_storage ON artifacts;
CREATE TRIGGER artifacts_account_storage
BEFORE INSERT OR UPDATE OF byte_size ON artifacts
FOR EACH ROW EXECUTE FUNCTION iterminal_account_artifact_storage();

DROP TRIGGER IF EXISTS artifacts_release_storage ON artifacts;
CREATE TRIGGER artifacts_release_storage
AFTER DELETE ON artifacts
FOR EACH ROW EXECUTE FUNCTION iterminal_release_artifact_storage();

DROP TRIGGER IF EXISTS artifacts_reset_storage ON artifacts;
CREATE TRIGGER artifacts_reset_storage
AFTER TRUNCATE ON artifacts
FOR EACH STATEMENT EXECUTE FUNCTION iterminal_reset_artifact_storage();

INSERT INTO schema_migrations (version)
VALUES (17)
ON CONFLICT (version) DO NOTHING;
