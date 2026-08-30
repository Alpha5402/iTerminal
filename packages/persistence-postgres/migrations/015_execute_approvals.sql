CREATE TABLE approvals (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  session_generation integer NOT NULL CHECK (session_generation > 0),
  operation text NOT NULL CHECK (operation = 'execution.start'),
  requester_actor_id text NOT NULL REFERENCES actors(id),
  action_idempotency_key text NOT NULL,
  action_request_hash text NOT NULL CHECK (length(action_request_hash) = 64),
  command text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 512),
  request_idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'CONSUMED')),
  version integer NOT NULL CHECK (version > 0),
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (
    expires_at >= requested_at + interval '30 seconds'
    AND expires_at <= requested_at + interval '30 minutes'
  ),
  approver_actor_id text REFERENCES actors(id),
  decided_at timestamptz,
  decision_idempotency_key text,
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 1 AND 512),
  decision_request_hash text CHECK (decision_request_hash IS NULL OR length(decision_request_hash) = 64),
  consumed_action_id text REFERENCES actions(id),
  consumed_at timestamptz,
  UNIQUE (session_id, requester_actor_id, request_idempotency_key),
  FOREIGN KEY (session_id, session_generation)
    REFERENCES session_generations(session_id, generation) ON DELETE CASCADE,
  CHECK (
    (status = 'PENDING' AND approver_actor_id IS NULL AND decided_at IS NULL
      AND decision_idempotency_key IS NULL AND decision_reason IS NULL
      AND decision_request_hash IS NULL AND consumed_action_id IS NULL AND consumed_at IS NULL)
    OR
    (status IN ('APPROVED', 'DENIED') AND approver_actor_id IS NOT NULL AND decided_at IS NOT NULL
      AND decision_idempotency_key IS NOT NULL AND decision_reason IS NOT NULL
      AND decision_request_hash IS NOT NULL AND consumed_action_id IS NULL AND consumed_at IS NULL)
    OR
    (status = 'EXPIRED' AND consumed_action_id IS NULL AND consumed_at IS NULL)
    OR
    (status = 'CONSUMED' AND approver_actor_id IS NOT NULL AND decided_at IS NOT NULL
      AND decision_idempotency_key IS NOT NULL AND decision_reason IS NOT NULL
      AND decision_request_hash IS NOT NULL AND consumed_action_id IS NOT NULL AND consumed_at IS NOT NULL)
  )
);

CREATE INDEX approvals_session_status_idx
  ON approvals (session_id, session_generation, status, requested_at DESC);

CREATE INDEX approvals_expiry_idx
  ON approvals (expires_at)
  WHERE status IN ('PENDING', 'APPROVED');

INSERT INTO schema_migrations (version)
VALUES (15)
ON CONFLICT (version) DO NOTHING;
