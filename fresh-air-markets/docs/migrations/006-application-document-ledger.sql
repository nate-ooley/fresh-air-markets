-- Additive, application-bound document ledger. Apply after 001-application-handoff.sql.
-- It stores private object references and digests only; raw uploads never enter
-- these rows. Existing HighLevel document/contact history is not modified.
BEGIN;

-- `id` is already unique, but the composite key makes market ownership an
-- enforceable part of every document foreign key below.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fame_applications_id_market_key'
  ) THEN
    ALTER TABLE fame_applications
      ADD CONSTRAINT fame_applications_id_market_key UNIQUE (id, market_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS fame_application_documents (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('insurance', 'food_license')),
  version INTEGER NOT NULL CHECK (version >= 1),
  source_event_id TEXT NOT NULL,
  source_file_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  submitted_at TIMESTAMPTZ NOT NULL,
  validation_state TEXT NOT NULL DEFAULT 'pending_scan'
    CHECK (validation_state IN ('pending_scan', 'ready_for_review', 'rejected')),
  validation_reason TEXT NOT NULL DEFAULT '',
  validated_at TIMESTAMPTZ,
  review_state TEXT NOT NULL DEFAULT 'submitted'
    CHECK (review_state IN ('submitted', 'approved', 'changes_requested', 'rejected')),
  review_revision INTEGER NOT NULL DEFAULT 0 CHECK (review_revision >= 0),
  reviewed_at TIMESTAMPTZ,
  reviewed_by_account_id TEXT REFERENCES accounts(id),
  review_reason TEXT NOT NULL DEFAULT '',
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (application_id, kind, version),
  UNIQUE (id, market_id),
  UNIQUE (id, application_id, market_id),
  FOREIGN KEY (application_id, market_id) REFERENCES fame_applications(id, market_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fame_application_documents_one_current_idx
  ON fame_application_documents(application_id, kind) WHERE is_current;
CREATE INDEX IF NOT EXISTS fame_application_documents_review_idx
  ON fame_application_documents(market_id, validation_state, review_state, created_at DESC);

-- The source event gives duplicate delivery a stable, conflict-detectable key.
CREATE TABLE IF NOT EXISTS fame_document_source_events (
  location_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  application_id TEXT NOT NULL,
  document_id TEXT,
  payload_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, event_id),
  FOREIGN KEY (application_id, market_id) REFERENCES fame_applications(id, market_id),
  FOREIGN KEY (document_id, application_id, market_id)
    REFERENCES fame_application_documents(id, application_id, market_id)
);
CREATE INDEX IF NOT EXISTS fame_document_source_events_application_idx
  ON fame_document_source_events(application_id, created_at DESC);

-- Delivery is independent of HighLevel. A worker claims, retries and marks
-- these messages only after its downstream operation succeeds.
CREATE TABLE IF NOT EXISTS fame_document_outbox (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  topic TEXT NOT NULL CHECK (topic IN (
    'document-submitted', 'document-ready-for-review',
    'document-validation-rejected', 'document-review'
  )),
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
CREATE INDEX IF NOT EXISTS fame_document_outbox_ready_idx
  ON fame_document_outbox(status, next_attempt_at, created_at);

-- A trusted scanner/deep parser records one immutable result for an exact
-- document version. A header match alone never unlocks manager approval.
CREATE TABLE IF NOT EXISTS fame_document_validation_events (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  source_event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('clean', 'rejected')),
  reason TEXT NOT NULL DEFAULT '',
  outbox_id TEXT REFERENCES fame_document_outbox(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, source_event_id),
  FOREIGN KEY (document_id, market_id) REFERENCES fame_application_documents(id, market_id)
);
CREATE INDEX IF NOT EXISTS fame_document_validation_events_document_idx
  ON fame_document_validation_events(document_id, created_at DESC);

-- Manager decisions are version-bound, actor-audited and coupled to an outbox
-- record in the same transaction. Later corrected files keep their own rows.
CREATE TABLE IF NOT EXISTS fame_document_review_events (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  outbox_id TEXT REFERENCES fame_document_outbox(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, idempotency_key),
  FOREIGN KEY (document_id, application_id, market_id)
    REFERENCES fame_application_documents(id, application_id, market_id)
);
CREATE INDEX IF NOT EXISTS fame_document_review_events_document_idx
  ON fame_document_review_events(document_id, created_at DESC);

COMMIT;
