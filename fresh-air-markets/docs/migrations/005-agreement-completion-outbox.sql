-- Additive exact-agreement binding, completion receipt, and notification queue.
-- Requires 001-application-handoff.sql and the portal accounts table. It does
-- not send email or alter HighLevel contacts; a separately deployed worker may
-- claim the durable queue only after its delivery configuration is reviewed.
BEGIN;

CREATE TABLE IF NOT EXISTS fame_agreement_events (
  location_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('issued', 'completed')),
  application_id TEXT REFERENCES fame_applications(id),
  document_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, event_id)
);
CREATE INDEX IF NOT EXISTS fame_agreement_events_application_idx
  ON fame_agreement_events(application_id, created_at);

-- A document can be issued only for the exact location/contact/season/
-- opportunity application. Newer unsigned documents supersede prior ones.
CREATE TABLE IF NOT EXISTS fame_agreement_issuances (
  location_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  application_id TEXT NOT NULL REFERENCES fame_applications(id),
  contact_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  issued_event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, document_id),
  UNIQUE (location_id, issued_event_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fame_agreement_one_active_issuance_idx
  ON fame_agreement_issuances(application_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS fame_agreement_issuance_document_idx
  ON fame_agreement_issuances(location_id, document_id, application_id);

-- Only one agreement may complete an application for a season. A different or
-- superseded document cannot replace this receipt later.
CREATE TABLE IF NOT EXISTS fame_agreement_completions (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL UNIQUE REFERENCES fame_applications(id),
  market_id TEXT NOT NULL REFERENCES accounts(id),
  location_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  completion_event_id TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, document_id),
  UNIQUE (location_id, completion_event_id)
);

-- No sender is embedded here. The item is created atomically with the receipt
-- and has a fenced lease so retrying a failed notification cannot create a
-- duplicate agreement completion or let a stale worker mark a newer lease.
CREATE TABLE IF NOT EXISTS fame_agreement_notification_outbox (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  application_id TEXT NOT NULL UNIQUE REFERENCES fame_applications(id),
  completion_id TEXT NOT NULL UNIQUE REFERENCES fame_agreement_completions(id),
  recipient_email TEXT NOT NULL CHECK (char_length(recipient_email) BETWEEN 3 AND 254),
  topic TEXT NOT NULL CHECK (topic = 'agreement-completed'),
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
CREATE INDEX IF NOT EXISTS fame_agreement_notification_outbox_ready_idx
  ON fame_agreement_notification_outbox(status, next_attempt_at, created_at);

COMMIT;
