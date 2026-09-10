-- Payment invitations and their notification are committed in one transaction.
-- No provider calls run in this migration. Requires 017; independent of 018.
BEGIN;

CREATE TABLE IF NOT EXISTS fame_payment_email_outbox (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  application_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  reservation_revision INTEGER NOT NULL CHECK (reservation_revision >= 1),
  source_location_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL CHECK (char_length(recipient_email) BETWEEN 3 AND 254),
  total_cents BIGINT NOT NULL CHECK (total_cents > 0),
  payment_due_at TIMESTAMPTZ NOT NULL,
  invitation_hash TEXT NOT NULL,
  -- AES-256-GCM envelope. Erased BEFORE attempting the non-idempotent POST.
  invitation_ciphertext TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending', 'preparing', 'send_started', 'accepted', 'delivered', 'failed', 'uncertain', 'cancelled')),
  prepare_attempts INTEGER NOT NULL DEFAULT 0 CHECK (prepare_attempts BETWEEN 0 AND 5),
  receipt_attempts INTEGER NOT NULL DEFAULT 0 CHECK (receipt_attempts >= 0),
  receipt_failures INTEGER NOT NULL DEFAULT 0 CHECK (receipt_failures BETWEEN 0 AND 5),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  lease_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  safe_error TEXT CHECK (safe_error IS NULL OR safe_error ~ '^payment_email_[a-z_]{1,80}$'),
  provider_message_id TEXT,
  provider_conversation_id TEXT,
  provider_email_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  send_started_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  UNIQUE (market_id, reservation_id, reservation_revision),
  FOREIGN KEY (reservation_id, market_id, application_id)
    REFERENCES fame_reservations(id, market_id, application_id),
  FOREIGN KEY (reservation_id, market_id)
    REFERENCES fame_reservation_finalizations(reservation_id, market_id),
  FOREIGN KEY (source_location_id, source_event_id, market_id, application_id)
    REFERENCES fame_application_events(location_id, event_id, market_id, application_id),
  FOREIGN KEY (invitation_hash, market_id, reservation_id, reservation_revision)
    REFERENCES fame_vendor_payment_invitations(token_hash, market_id, reservation_id, reservation_revision),
  CHECK ((state IN ('pending', 'preparing')) = (invitation_ciphertext IS NOT NULL)),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK (state <> 'preparing' OR lease_id IS NOT NULL),
  CHECK (state NOT IN ('accepted', 'delivered') OR
    (provider_message_id IS NOT NULL AND provider_conversation_id IS NOT NULL AND provider_email_message_id IS NOT NULL)),
  CHECK (state NOT IN ('send_started', 'accepted', 'delivered', 'uncertain') OR send_started_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS fame_payment_email_ready_idx
  ON fame_payment_email_outbox(market_id, next_attempt_at, created_at)
  WHERE state IN ('pending', 'preparing', 'send_started', 'accepted');

CREATE OR REPLACE FUNCTION fame_payment_email_identity_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.market_id, NEW.application_id, NEW.reservation_id, NEW.reservation_revision,
      NEW.source_location_id, NEW.source_event_id, NEW.contact_id, NEW.opportunity_id, NEW.recipient_email,
      NEW.total_cents, NEW.payment_due_at, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.market_id, OLD.application_id, OLD.reservation_id, OLD.reservation_revision,
      OLD.source_location_id, OLD.source_event_id, OLD.contact_id, OLD.opportunity_id, OLD.recipient_email,
      OLD.total_cents, OLD.payment_due_at, OLD.created_at) THEN
      RAISE EXCEPTION 'payment email identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.invitation_hash IS DISTINCT FROM OLD.invitation_hash AND NOT (
      OLD.send_started_at IS NULL AND OLD.state IN ('failed', 'cancelled')
      AND NEW.send_started_at IS NULL AND NEW.state = 'pending' AND NEW.prepare_attempts = 0
      AND NEW.invitation_ciphertext IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'payment email invitation cannot rotate after a send attempt' USING ERRCODE = '55000';
    END IF;
    IF OLD.send_started_at IS NOT NULL AND (NEW.invitation_ciphertext IS NOT NULL OR NEW.send_started_at IS DISTINCT FROM OLD.send_started_at) THEN
      RAISE EXCEPTION 'payment email send cannot be restarted' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.market_id = 'demo-market' OR NOT EXISTS (
    SELECT 1 FROM fame_reservation_finalizations f
    JOIN fame_reservations r ON r.id = f.reservation_id AND r.market_id = f.market_id AND r.application_id = f.application_id
    JOIN fame_agreement_completions g ON g.id = f.agreement_completion_id AND g.market_id = f.market_id AND g.application_id = f.application_id
    JOIN fame_application_events e ON e.location_id = f.application_source_location_id AND e.event_id = f.application_source_event_id
      AND e.market_id = f.market_id AND e.application_id = f.application_id
    JOIN fame_payment_orders p ON p.reservation_id = r.id AND p.market_id = r.market_id AND p.reservation_revision = r.revision
    WHERE f.reservation_id = NEW.reservation_id AND f.market_id = NEW.market_id AND f.application_id = NEW.application_id
      AND r.revision = NEW.reservation_revision AND r.state = 'payment_pending' AND r.payment_required = TRUE
      AND p.status = 'checkout_created' AND r.currency = 'USD' AND p.expected_currency = 'USD'
      AND r.total_cents = NEW.total_cents AND p.expected_total_cents = NEW.total_cents
      AND r.payment_due_at = NEW.payment_due_at AND p.payment_due_at = NEW.payment_due_at
      AND r.payment_request_sent_at = p.payment_request_sent_at
      AND r.payment_due_at = r.payment_request_sent_at + INTERVAL '48 hours'
      AND NEW.payment_due_at > NEW.created_at
      AND e.location_id = NEW.source_location_id AND e.event_id = NEW.source_event_id
      AND g.location_id = NEW.source_location_id AND g.contact_id = NEW.contact_id AND g.opportunity_id = NEW.opportunity_id
      AND lower(btrim(e.snapshot->>'email')) = NEW.recipient_email
  ) THEN
    RAISE EXCEPTION 'payment email requires exact committed payment and recipient evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fame_payment_email_identity_guard ON fame_payment_email_outbox;
CREATE TRIGGER fame_payment_email_identity_guard BEFORE INSERT OR UPDATE ON fame_payment_email_outbox
  FOR EACH ROW EXECUTE FUNCTION fame_payment_email_identity_guard();
COMMIT;
