-- Exact committed checkout -> CRM Payment Pending. Requires 013, 018 and 007.
-- No provider operations occur here; both stage workers share a reservation advisory lock.
BEGIN;
CREATE TABLE IF NOT EXISTS fame_payment_pending_sync_outbox (
  payment_order_id TEXT PRIMARY KEY REFERENCES fame_payment_orders(id),
  market_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  agreement_completion_id TEXT NOT NULL REFERENCES fame_agreement_completions(id),
  location_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  reservation_revision INTEGER NOT NULL CHECK (reservation_revision > 0),
  square_environment TEXT NOT NULL CHECK (square_environment IN ('sandbox', 'production')),
  square_order_id TEXT NOT NULL,
  payment_due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'manual_review', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  lease_token TEXT,
  delivered_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (application_id, market_id) REFERENCES fame_applications(id, market_id),
  FOREIGN KEY (reservation_id, market_id) REFERENCES fame_reservation_finalizations(reservation_id, market_id),
  CHECK ((status = 'processing') = (locked_until IS NOT NULL AND lease_token IS NOT NULL)),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS fame_payment_pending_sync_ready_idx
  ON fame_payment_pending_sync_outbox(market_id, season_id, square_environment, next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');

CREATE OR REPLACE VIEW fame_payment_pending_sync_eligible AS
SELECT o.id AS payment_order_id, o.market_id, a.id AS application_id, f.agreement_completion_id,
       a.location_id, a.contact_id, a.opportunity_id, a.season_id, o.reservation_id,
       o.reservation_revision, o.square_environment, o.square_order_id, o.payment_due_at
FROM fame_payment_orders o
JOIN fame_reservations r ON r.id = o.reservation_id AND r.market_id = o.market_id
JOIN fame_reservation_finalizations f ON f.reservation_id = r.id AND f.market_id = r.market_id AND f.application_id = r.application_id
JOIN fame_applications a ON a.id = f.application_id AND a.market_id = f.market_id
JOIN fame_agreement_completions g ON g.id = f.agreement_completion_id AND g.market_id = f.market_id AND g.application_id = f.application_id
  AND g.location_id = a.location_id AND g.contact_id = a.contact_id AND g.opportunity_id = a.opportunity_id AND g.season_id = a.season_id
WHERE o.status = 'checkout_created' AND r.state = 'payment_pending' AND r.payment_required
  AND o.market_id <> 'demo-market' AND r.revision = o.reservation_revision
  AND r.currency = 'USD' AND o.expected_currency = 'USD' AND r.total_cents = o.expected_total_cents AND r.total_cents > 0
  AND o.square_order_id IS NOT NULL AND o.square_payment_link_id IS NOT NULL AND o.checkout_url IS NOT NULL
  AND o.payment_id IS NULL AND o.payment_received_at IS NULL
  AND o.payment_due_at = r.payment_due_at AND o.payment_request_sent_at = r.payment_request_sent_at
  AND o.payment_due_at = o.payment_request_sent_at + INTERVAL '48 hours'
  AND o.payment_due_at > statement_timestamp();

CREATE OR REPLACE FUNCTION fame_enqueue_payment_pending_sync(p_order_id TEXT)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE inserted_count INTEGER;
BEGIN
  INSERT INTO fame_payment_pending_sync_outbox (payment_order_id, market_id, application_id, agreement_completion_id,
    location_id, contact_id, opportunity_id, season_id, reservation_id, reservation_revision, square_environment, square_order_id, payment_due_at)
  SELECT payment_order_id, market_id, application_id, agreement_completion_id, location_id, contact_id, opportunity_id,
    season_id, reservation_id, reservation_revision, square_environment, square_order_id, payment_due_at
  FROM fame_payment_pending_sync_eligible WHERE payment_order_id = p_order_id ON CONFLICT (payment_order_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;
CREATE OR REPLACE FUNCTION fame_queue_payment_pending_sync()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'checkout_created' THEN PERFORM fame_enqueue_payment_pending_sync(NEW.id); END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS fame_payment_pending_sync_enqueue ON fame_payment_orders;
CREATE CONSTRAINT TRIGGER fame_payment_pending_sync_enqueue AFTER INSERT OR UPDATE OF status ON fame_payment_orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fame_queue_payment_pending_sync();

CREATE OR REPLACE FUNCTION fame_payment_pending_sync_identity_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','attempts','next_attempt_at','locked_until','lease_token','delivered_at','last_error_code','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','attempts','next_attempt_at','locked_until','lease_token','delivered_at','last_error_code','updated_at']) THEN
    RAISE EXCEPTION 'Pending sync identity cannot be reassigned';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS fame_payment_pending_sync_identity_guard ON fame_payment_pending_sync_outbox;
CREATE TRIGGER fame_payment_pending_sync_identity_guard BEFORE UPDATE ON fame_payment_pending_sync_outbox
  FOR EACH ROW EXECUTE FUNCTION fame_payment_pending_sync_identity_guard();
COMMIT;
