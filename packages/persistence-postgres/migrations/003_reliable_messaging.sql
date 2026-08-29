ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS claimed_by text,
  ADD COLUMN IF NOT EXISTS claim_token text,
  ADD COLUMN IF NOT EXISTS claimed_until timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_error text;

DROP INDEX IF EXISTS outbox_pending_idx;

CREATE INDEX IF NOT EXISTS outbox_delivery_pending_idx
  ON outbox (next_attempt_at, created_at, id)
  WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS consumer_inbox (
  consumer_id text NOT NULL,
  message_id text NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token text,
  claimed_until timestamptz,
  outcome text,
  last_error text,
  first_received_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (consumer_id, message_id)
);

CREATE INDEX IF NOT EXISTS consumer_inbox_claim_idx
  ON consumer_inbox (status, claimed_until)
  WHERE status <> 'COMPLETED';

INSERT INTO schema_migrations (version)
VALUES (3)
ON CONFLICT (version) DO NOTHING;
