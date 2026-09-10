-- Durable exact-opportunity delivery after a signed agreement is recorded.
-- Apply after 005-agreement-completion-outbox.sql. This intentionally keeps
-- the existing internal-notification queue separate from CRM stage delivery:
-- completing a CRM update must never claim that an email was sent.
BEGIN;

CREATE TABLE IF NOT EXISTS fame_agreement_stage_outbox (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  application_id TEXT NOT NULL UNIQUE REFERENCES fame_applications(id),
  completion_id TEXT NOT NULL UNIQUE REFERENCES fame_agreement_completions(id),
  topic TEXT NOT NULL CHECK (topic = 'agreement-completed-stage'),
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  lease_token TEXT,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS fame_agreement_stage_outbox_ready_idx
  ON fame_agreement_stage_outbox(status, next_attempt_at, created_at);

COMMIT;
