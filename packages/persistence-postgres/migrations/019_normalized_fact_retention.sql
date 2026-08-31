CREATE TABLE IF NOT EXISTS durable_fact_retention_policies (
  scope text PRIMARY KEY CHECK (scope = 'default'),
  retention_milliseconds bigint NOT NULL
    CHECK (retention_milliseconds > 0 AND retention_milliseconds <= 315360000000),
  cleanup_batch_size integer NOT NULL CHECK (cleanup_batch_size BETWEEN 1 AND 100000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO durable_fact_retention_policies
  (scope, retention_milliseconds, cleanup_batch_size)
VALUES ('default', 2592000000, 1000)
ON CONFLICT (scope) DO NOTHING;

CREATE INDEX IF NOT EXISTS approvals_fact_retention_idx
  ON approvals (
    coalesce(consumed_at, decided_at, expires_at, requested_at), id
  );

CREATE INDEX IF NOT EXISTS outbox_fact_retention_idx
  ON outbox (published_at, id)
  WHERE published_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS consumer_inbox_fact_retention_idx
  ON consumer_inbox (completed_at, consumer_id, message_id)
  WHERE status = 'COMPLETED';

CREATE INDEX IF NOT EXISTS actions_fact_retention_idx
  ON actions (updated_at, id)
  WHERE status IN ('COMPLETED', 'FAILED', 'INTERRUPTED', 'UNKNOWN');

CREATE TABLE IF NOT EXISTS database_capacity_policies (
  scope text PRIMARY KEY CHECK (scope = 'default'),
  max_bytes bigint NOT NULL CHECK (max_bytes > 0 AND max_bytes <= 9007199254740991),
  warning_percent integer NOT NULL CHECK (warning_percent BETWEEN 1 AND 99),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO database_capacity_policies (scope, max_bytes, warning_percent)
VALUES ('default', 10737418240, 80)
ON CONFLICT (scope) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES (19)
ON CONFLICT (version) DO NOTHING;
