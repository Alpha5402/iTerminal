ALTER TABLE retention_policies
  ADD COLUMN IF NOT EXISTS cleanup_batch_size integer NOT NULL DEFAULT 10000;

ALTER TABLE retention_policies
  DROP CONSTRAINT IF EXISTS retention_policies_cleanup_batch_size_check;
ALTER TABLE retention_policies
  ADD CONSTRAINT retention_policies_cleanup_batch_size_check
  CHECK (cleanup_batch_size BETWEEN 1 AND 100000);

CREATE TABLE event_retention_watermarks (
  session_id text NOT NULL,
  session_generation integer NOT NULL,
  deleted_through_sequence bigint NOT NULL CHECK (deleted_through_sequence >= 0),
  deleted_events bigint NOT NULL CHECK (deleted_events >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, session_generation)
);

INSERT INTO event_retention_watermarks
  (session_id, session_generation, deleted_through_sequence, deleted_events)
SELECT generation.session_id,
       generation.generation,
       CASE
         WHEN count(event.id) = 0 THEN generation.next_event_sequence
         WHEN max(event.event_sequence) = generation.next_event_sequence
              AND count(event.id) = max(event.event_sequence) - min(event.event_sequence) + 1
           THEN min(event.event_sequence) - 1
         WHEN max(event.event_sequence) = generation.next_event_sequence
           THEN generation.next_event_sequence - 1
         ELSE generation.next_event_sequence
       END,
       generation.next_event_sequence - count(event.id)
  FROM session_generations generation
  LEFT JOIN session_events event
    ON event.session_id = generation.session_id
   AND event.session_generation = generation.generation
 GROUP BY generation.session_id, generation.generation, generation.next_event_sequence
HAVING count(event.id) < generation.next_event_sequence
ON CONFLICT (session_id, session_generation) DO NOTHING;

CREATE OR REPLACE FUNCTION iterminal_record_event_retention()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.event_retention_watermarks
    (session_id, session_generation, deleted_through_sequence, deleted_events, updated_at)
  SELECT session_id, session_generation, max(event_sequence), count(*), now()
    FROM deleted_events
   GROUP BY session_id, session_generation
  ON CONFLICT (session_id, session_generation) DO UPDATE
    SET deleted_through_sequence = GREATEST(
          public.event_retention_watermarks.deleted_through_sequence,
          EXCLUDED.deleted_through_sequence
        ),
        deleted_events = public.event_retention_watermarks.deleted_events + EXCLUDED.deleted_events,
        updated_at = now();
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS session_events_record_retention ON session_events;
CREATE TRIGGER session_events_record_retention
AFTER DELETE ON session_events
REFERENCING OLD TABLE AS deleted_events
FOR EACH STATEMENT EXECUTE FUNCTION iterminal_record_event_retention();

CREATE OR REPLACE FUNCTION iterminal_record_event_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.event_retention_watermarks
    (session_id, session_generation, deleted_through_sequence, deleted_events, updated_at)
  SELECT session_id, session_generation, max(event_sequence), count(*), now()
    FROM public.session_events
   GROUP BY session_id, session_generation
  ON CONFLICT (session_id, session_generation) DO UPDATE
    SET deleted_through_sequence = GREATEST(
          public.event_retention_watermarks.deleted_through_sequence,
          EXCLUDED.deleted_through_sequence
        ),
        deleted_events = public.event_retention_watermarks.deleted_events + EXCLUDED.deleted_events,
        updated_at = now();
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS session_events_record_truncate ON session_events;
CREATE TRIGGER session_events_record_truncate
BEFORE TRUNCATE ON session_events
FOR EACH STATEMENT EXECUTE FUNCTION iterminal_record_event_truncate();

CREATE OR REPLACE FUNCTION iterminal_remove_event_retention_watermark()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.event_retention_watermarks
   WHERE session_id = OLD.session_id AND session_generation = OLD.generation;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS session_generations_remove_event_retention_watermark
  ON session_generations;
CREATE TRIGGER session_generations_remove_event_retention_watermark
AFTER DELETE ON session_generations
FOR EACH ROW EXECUTE FUNCTION iterminal_remove_event_retention_watermark();

CREATE OR REPLACE FUNCTION iterminal_clear_event_retention_watermarks()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.event_retention_watermarks;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS session_generations_clear_event_retention_watermarks
  ON session_generations;
CREATE TRIGGER session_generations_clear_event_retention_watermarks
AFTER TRUNCATE ON session_generations
FOR EACH STATEMENT EXECUTE FUNCTION iterminal_clear_event_retention_watermarks();

INSERT INTO schema_migrations (version)
VALUES (18)
ON CONFLICT (version) DO NOTHING;
