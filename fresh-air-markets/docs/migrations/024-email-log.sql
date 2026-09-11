-- Outbound email log for the portal's own notifications (vendor and staff).
-- Every attempt is recorded with the provider's message id or the failure code;
-- message bodies are not stored.
BEGIN;

CREATE TABLE IF NOT EXISTS fame_email_log (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 64),
  to_email TEXT NOT NULL CHECK (char_length(to_email) BETWEEN 3 AND 254),
  subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 300),
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  provider_message_id TEXT,
  error_code TEXT NOT NULL DEFAULT '',
  reference_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fame_email_log_market_idx ON fame_email_log(market_id, created_at DESC);

COMMIT;
