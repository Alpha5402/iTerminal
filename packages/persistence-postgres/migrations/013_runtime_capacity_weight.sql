ALTER TABLE runtime_workers
  ADD COLUMN IF NOT EXISTS capacity_weight integer NOT NULL DEFAULT 1;

ALTER TABLE runtime_workers DROP CONSTRAINT IF EXISTS runtime_workers_capacity_weight_check;
ALTER TABLE runtime_workers
  ADD CONSTRAINT runtime_workers_capacity_weight_check
  CHECK (capacity_weight BETWEEN 1 AND 1000);

INSERT INTO schema_migrations (version)
VALUES (13)
ON CONFLICT (version) DO NOTHING;
