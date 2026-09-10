-- Additive application-decision audit and durable outbound work queue.
-- Requires 001-application-handoff.sql and the portal accounts table.
-- This creates a portal review state; it never overwrites HighLevel history
-- stored in the immutable source snapshots.
BEGIN;

ALTER TABLE fame_applications
  ADD COLUMN IF NOT EXISTS review_state TEXT NOT NULL DEFAULT 'unreviewed',
  ADD COLUMN IF NOT EXISTS review_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by_account_id TEXT REFERENCES accounts(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fame_applications_review_state_check'
      AND conrelid = 'fame_applications'::regclass
  ) THEN
    ALTER TABLE fame_applications
      ADD CONSTRAINT fame_applications_review_state_check
      CHECK (review_state IN ('unreviewed', 'needs_review', 'changes_requested', 'approved', 'declined'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fame_applications_review_revision_check'
      AND conrelid = 'fame_applications'::regclass
  ) THEN
    ALTER TABLE fame_applications
      ADD CONSTRAINT fame_applications_review_revision_check CHECK (review_revision >= 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS fame_application_outbox (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  topic TEXT NOT NULL CHECK (topic = 'application-review'),
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
CREATE INDEX IF NOT EXISTS fame_application_outbox_ready_idx
  ON fame_application_outbox(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS fame_application_review_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES fame_applications(id),
  market_id TEXT NOT NULL REFERENCES accounts(id),
  source_event_id TEXT NOT NULL,
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  outbox_id TEXT REFERENCES fame_application_outbox(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (application_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS fame_application_review_events_application_idx
  ON fame_application_review_events(application_id, created_at DESC);

COMMIT;
