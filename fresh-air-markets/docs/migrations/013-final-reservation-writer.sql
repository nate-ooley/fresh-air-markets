-- Atomic Fresh Air CHECK -> RESERVE ledger.
--
-- Apply after 001, 004, 005, 006, 007, 008, 009, 010, 011 and 012. In
-- particular, 006 supplies the tenant-bound application key, and 011 supplies
-- fame_reservations. This migration has no worker and sends no email, SMS,
-- HighLevel update, or Square request.
BEGIN;

-- The triple lets the immutable finalization prove that its reservation and
-- application belong to the same market. `id` remains the primary identity;
-- this extra candidate key exists only for the compound foreign key below.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fame_reservations_id_market_application_key'
      AND conrelid = 'fame_reservations'::regclass
  ) THEN
    ALTER TABLE fame_reservations
      ADD CONSTRAINT fame_reservations_id_market_application_key
      UNIQUE (id, market_id, application_id);
  END IF;
END $$;

-- The original ledgers use a short primary key for their event ID. These
-- candidate keys let the finalization bind that ID back to the exact market,
-- application and source event rather than merely retaining a loose string.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fame_application_events_source_application_key'
      AND conrelid = 'fame_application_events'::regclass
  ) THEN
    ALTER TABLE fame_application_events
      ADD CONSTRAINT fame_application_events_source_application_key
      UNIQUE (location_id, event_id, market_id, application_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fame_application_review_events_finalization_key'
      AND conrelid = 'fame_application_review_events'::regclass
  ) THEN
    ALTER TABLE fame_application_review_events
      ADD CONSTRAINT fame_application_review_events_finalization_key
      UNIQUE (id, application_id, market_id, source_event_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fame_agreement_completions_finalization_key'
      AND conrelid = 'fame_agreement_completions'::regclass
  ) THEN
    ALTER TABLE fame_agreement_completions
      ADD CONSTRAINT fame_agreement_completions_finalization_key
      UNIQUE (id, application_id, market_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS fame_reservation_finalizations (
  reservation_id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  application_id TEXT NOT NULL,
  -- Every eligibility input is bound to one durable upstream record. The
  -- writer verifies states before insert; these keys preserve exactly which
  -- evidence qualified the hold when newer files/events later arrive.
  application_review_revision INTEGER NOT NULL CHECK (application_review_revision >= 1),
  application_review_event_id TEXT NOT NULL,
  application_source_location_id TEXT NOT NULL,
  application_source_event_id TEXT NOT NULL,
  agreement_completion_id TEXT NOT NULL,
  insurance_document_id TEXT NOT NULL,
  insurance_document_version INTEGER NOT NULL CHECK (insurance_document_version >= 1),
  insurance_document_review_revision INTEGER NOT NULL CHECK (insurance_document_review_revision >= 1),
  food_license_document_id TEXT,
  food_license_document_version INTEGER,
  food_license_document_review_revision INTEGER,
  idempotency_key TEXT NOT NULL,
  selection_fingerprint TEXT NOT NULL CHECK (selection_fingerprint ~ '^[a-f0-9]{64}$'),
  applicant_type TEXT NOT NULL CHECK (applicant_type IN ('Vendor', 'Non-Profit Organization')),
  vendor_category TEXT NOT NULL CHECK (char_length(vendor_category) BETWEEN 1 AND 128),
  full_season BOOLEAN NOT NULL,
  food_license_required BOOLEAN NOT NULL,
  quote_tier TEXT NOT NULL CHECK (quote_tier IN ('standard', 'consecutive', 'full-season', 'nonprofit')),
  rate_cents INTEGER NOT NULL CHECK (
    (quote_tier = 'standard' AND rate_cents = 4000)
    OR (quote_tier = 'consecutive' AND rate_cents = 3500)
    OR (quote_tier = 'full-season' AND rate_cents = 3000)
    OR (quote_tier = 'nonprofit' AND rate_cents = 0)
  ),
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reservation_id, market_id),
  UNIQUE (market_id, application_id),
  UNIQUE (market_id, idempotency_key),
  CHECK (created_by_account_id = market_id),
  CHECK (idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (
    applicant_type <> 'Vendor'
    OR vendor_category IN (
      'Food Truck', 'Entertainment', 'Arts & Crafts', 'Food Products', 'Produce',
      'Florals & Plants', 'Health & Personal Care', 'Jewelry & Accessories',
      'Home Goods', 'Clothing & Apparel', 'Pet Products', 'Coffee & Tea',
      'Baked Goods', 'Other (please specify)'
    )
  ),
  CHECK (
    (applicant_type = 'Non-Profit Organization' AND quote_tier = 'nonprofit')
    OR (applicant_type = 'Vendor' AND (
      (full_season AND quote_tier = 'full-season')
      OR (NOT full_season AND quote_tier IN ('standard', 'consecutive'))
    ))
  ),
  FOREIGN KEY (reservation_id, market_id, application_id)
    REFERENCES fame_reservations(id, market_id, application_id),
  FOREIGN KEY (application_id, market_id)
    REFERENCES fame_applications(id, market_id),
  FOREIGN KEY (application_source_location_id, application_source_event_id, market_id, application_id)
    REFERENCES fame_application_events(location_id, event_id, market_id, application_id),
  FOREIGN KEY (application_review_event_id, application_id, market_id, application_source_event_id)
    REFERENCES fame_application_review_events(id, application_id, market_id, source_event_id),
  FOREIGN KEY (agreement_completion_id, application_id, market_id)
    REFERENCES fame_agreement_completions(id, application_id, market_id),
  FOREIGN KEY (insurance_document_id, application_id, market_id)
    REFERENCES fame_application_documents(id, application_id, market_id),
  FOREIGN KEY (food_license_document_id, application_id, market_id)
    REFERENCES fame_application_documents(id, application_id, market_id),
  CHECK (
    (food_license_required
      AND food_license_document_id IS NOT NULL
      AND food_license_document_version >= 1
      AND food_license_document_review_revision >= 1)
    OR (NOT food_license_required
      AND food_license_document_id IS NULL
      AND food_license_document_version IS NULL
      AND food_license_document_review_revision IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS fame_reservation_finalizations_market_created_idx
  ON fame_reservation_finalizations(market_id, created_at DESC);

-- FKs bind exact row identities. This trigger additionally makes the database
-- validate the eligibility semantics, source-currentness, document kind and
-- recorded version/review revision before it accepts an immutable audit row.
-- It is intentionally independent of browser/route validation.
CREATE OR REPLACE FUNCTION fame_final_reservation_evidence_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_source_event_id TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM fame_applications a
    WHERE a.id = NEW.application_id
      AND a.market_id = NEW.market_id
      AND a.review_state = 'approved'
      AND a.review_revision = NEW.application_review_revision
  ) THEN
    RAISE EXCEPTION 'final reservation requires the current approved application'
      USING ERRCODE = '23514';
  END IF;

  SELECT e.event_id INTO current_source_event_id
  FROM fame_application_events e
  WHERE e.application_id = NEW.application_id
    AND e.market_id = NEW.market_id
    AND e.location_id = NEW.application_source_location_id
  ORDER BY e.created_at DESC, e.event_id DESC
  LIMIT 1;
  IF current_source_event_id IS DISTINCT FROM NEW.application_source_event_id THEN
    RAISE EXCEPTION 'final reservation source event is not current'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM fame_application_review_events r
    WHERE r.id = NEW.application_review_event_id
      AND r.application_id = NEW.application_id
      AND r.market_id = NEW.market_id
      AND r.source_event_id = NEW.application_source_event_id
      AND r.to_state = 'approved'
  ) THEN
    RAISE EXCEPTION 'final reservation requires an approved review event'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM fame_agreement_completions g
    JOIN fame_applications a ON a.id = g.application_id AND a.market_id = g.market_id
    WHERE g.id = NEW.agreement_completion_id
      AND g.application_id = NEW.application_id
      AND g.market_id = NEW.market_id
      AND g.season_id = a.season_id
  ) THEN
    RAISE EXCEPTION 'final reservation requires the signed application agreement'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM fame_application_documents d
    WHERE d.id = NEW.insurance_document_id
      AND d.application_id = NEW.application_id
      AND d.market_id = NEW.market_id
      AND d.kind = 'insurance'
      AND d.is_current = TRUE
      AND d.validation_state = 'ready_for_review'
      AND d.review_state = 'approved'
      AND d.version = NEW.insurance_document_version
      AND d.review_revision = NEW.insurance_document_review_revision
  ) THEN
    RAISE EXCEPTION 'final reservation requires the current approved insurance document'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.food_license_required AND NOT EXISTS (
    SELECT 1
    FROM fame_application_documents d
    WHERE d.id = NEW.food_license_document_id
      AND d.application_id = NEW.application_id
      AND d.market_id = NEW.market_id
      AND d.kind = 'food_license'
      AND d.is_current = TRUE
      AND d.validation_state = 'ready_for_review'
      AND d.review_state = 'approved'
      AND d.version = NEW.food_license_document_version
      AND d.review_revision = NEW.food_license_document_review_revision
  ) THEN
    RAISE EXCEPTION 'final reservation requires the current approved food license'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM fame_reservations r
    WHERE r.id = NEW.reservation_id
      AND r.market_id = NEW.market_id
      AND r.application_id = NEW.application_id
      AND r.final_booth_quantity >= 1
      AND r.total_cents = jsonb_array_length(r.final_dates) * NEW.rate_cents * r.final_booth_quantity
      AND (
        (NEW.applicant_type = 'Vendor'
          AND r.payment_required = TRUE
          AND r.state = 'held')
        OR (NEW.applicant_type = 'Non-Profit Organization'
          AND r.payment_required = FALSE
          AND r.total_cents = 0
          AND r.state = 'confirmed')
      )
  ) THEN
    RAISE EXCEPTION 'final reservation quote or initial state is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fame_final_reservation_evidence_guard
  ON fame_reservation_finalizations;
CREATE TRIGGER fame_final_reservation_evidence_guard
  BEFORE INSERT ON fame_reservation_finalizations
  FOR EACH ROW EXECUTE FUNCTION fame_final_reservation_evidence_guard();

-- One durable allocation per final date. Capacity queries include only
-- reservation states that still occupy space; a rollback creates no rows.
CREATE TABLE IF NOT EXISTS fame_reservation_allocations (
  reservation_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  market_date DATE NOT NULL,
  booth_quantity INTEGER NOT NULL CHECK (booth_quantity >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (reservation_id, market_date),
  FOREIGN KEY (reservation_id, market_id)
    REFERENCES fame_reservation_finalizations(reservation_id, market_id)
);

CREATE INDEX IF NOT EXISTS fame_reservation_allocations_market_date_idx
  ON fame_reservation_allocations(market_id, market_date);

-- An atomic finalization is audit evidence, never a mutable work item. State
-- changes belong to fame_reservations/fame_payment_orders and do not alter the
-- chosen dates, quantity, rate, eligibility decision, or provenance.
CREATE OR REPLACE FUNCTION fame_final_reservation_audit_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'final reservation audit rows are immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS fame_reservation_finalizations_immutable
  ON fame_reservation_finalizations;
CREATE TRIGGER fame_reservation_finalizations_immutable
  BEFORE UPDATE OR DELETE ON fame_reservation_finalizations
  FOR EACH ROW EXECUTE FUNCTION fame_final_reservation_audit_immutable();

DROP TRIGGER IF EXISTS fame_reservation_allocations_immutable
  ON fame_reservation_allocations;
CREATE TRIGGER fame_reservation_allocations_immutable
  BEFORE UPDATE OR DELETE ON fame_reservation_allocations
  FOR EACH ROW EXECUTE FUNCTION fame_final_reservation_audit_immutable();

-- Once the companion audit row exists, quote-bearing reservation fields may
-- never change. Checkout/webhook processing may still update only lifecycle
-- state and payment timestamps, which preserves the 48-hour payment flow.
CREATE OR REPLACE FUNCTION fame_final_reservation_quote_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM fame_reservation_finalizations f
    WHERE f.reservation_id = OLD.id AND f.market_id = OLD.market_id
  ) THEN
    RAISE EXCEPTION 'final reservation quote fields are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fame_final_reservation_quote_guard
  ON fame_reservations;
CREATE TRIGGER fame_final_reservation_quote_guard
  BEFORE UPDATE OF application_id, revision, payment_required, currency,
                   total_cents, checkout_description, quote_version,
                   final_booth_quantity, final_dates
  ON fame_reservations
  FOR EACH ROW EXECUTE FUNCTION fame_final_reservation_quote_guard();

CREATE OR REPLACE FUNCTION fame_final_reservation_delete_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM fame_reservation_finalizations f
    WHERE f.reservation_id = OLD.id AND f.market_id = OLD.market_id
  ) THEN
    RAISE EXCEPTION 'final reservations cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS fame_final_reservation_delete_guard
  ON fame_reservations;
CREATE TRIGGER fame_final_reservation_delete_guard
  BEFORE DELETE ON fame_reservations
  FOR EACH ROW EXECUTE FUNCTION fame_final_reservation_delete_guard();

COMMIT;
