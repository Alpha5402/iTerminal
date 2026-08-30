ALTER TABLE actors
  ADD COLUMN IF NOT EXISTS capabilities text[];

UPDATE actors
   SET capabilities = CASE actor_type
     WHEN 'human' THEN ARRAY[
       'approval.decide',
       'approval.request',
       'interaction.guard.manage',
       'interaction.policy.manage',
       'secret.input',
       'session.execute',
       'session.fork',
       'terminal.control',
       'terminal.input',
       'terminal.resize'
     ]::text[]
     WHEN 'agent' THEN ARRAY[
       'approval.request',
       'session.execute',
       'session.fork',
       'terminal.control',
       'terminal.input',
       'terminal.resize'
     ]::text[]
     WHEN 'scheduler' THEN ARRAY['session.execute']::text[]
     WHEN 'system' THEN ARRAY[
       'interaction.policy.manage',
       'session.execute',
       'session.fork',
       'terminal.control',
       'terminal.resize'
     ]::text[]
   END
 WHERE capabilities IS NULL;

ALTER TABLE actors
  ALTER COLUMN capabilities SET NOT NULL;

CREATE OR REPLACE FUNCTION iterminal_actor_capabilities_are_canonical(text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT cardinality($1) > 0
     AND $1 = ARRAY(
       SELECT DISTINCT capability
         FROM unnest($1) AS capability
        ORDER BY capability
     );
$$;

ALTER TABLE actors
  DROP CONSTRAINT IF EXISTS actors_capabilities_known;
ALTER TABLE actors
  ADD CONSTRAINT actors_capabilities_known CHECK (
    iterminal_actor_capabilities_are_canonical(capabilities)
    AND capabilities <@ ARRAY[
      'approval.decide',
      'approval.request',
      'interaction.guard.manage',
      'interaction.policy.manage',
      'secret.input',
      'session.execute',
      'session.fork',
      'terminal.control',
      'terminal.input',
      'terminal.resize'
    ]::text[]
  );
