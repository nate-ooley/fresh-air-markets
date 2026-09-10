-- Enqueue only a reconciled, exact Square COMPLETED payment. No provider calls.
-- Deferred because the webhook writes order, reservation, then receipt atomically.
BEGIN;
CREATE TABLE IF NOT EXISTS fame_payment_paid_sync_outbox (
  payment_order_id TEXT PRIMARY KEY REFERENCES fame_payment_orders(id),
  market_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  reservation_revision INTEGER NOT NULL CHECK (reservation_revision > 0),
  square_environment TEXT NOT NULL CHECK (square_environment IN ('sandbox', 'production')),
  square_merchant_id TEXT NOT NULL,
  square_location_id TEXT NOT NULL,
  square_order_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'manual_review')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  lease_token TEXT,
  delivered_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (application_id, market_id) REFERENCES fame_applications(id, market_id),
  FOREIGN KEY (reservation_id, market_id) REFERENCES fame_reservations(id, market_id),
  FOREIGN KEY (square_environment, event_id) REFERENCES fame_square_webhook_events(square_environment, event_id),
  CHECK ((status = 'processing') = (locked_until IS NOT NULL AND lease_token IS NOT NULL)),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS fame_payment_paid_sync_pending_idx
  ON fame_payment_paid_sync_outbox(market_id, season_id, square_environment, next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');

-- Reused for first-transition enqueue, bounded repair scans and worker checks.
CREATE OR REPLACE VIEW fame_payment_paid_sync_eligible AS
SELECT o.id AS payment_order_id, o.market_id, a.id AS application_id,
       a.location_id, a.contact_id, a.opportunity_id, a.season_id,
       o.reservation_id, o.reservation_revision, o.square_environment,
       o.square_merchant_id, o.square_location_id, o.square_order_id,
       o.payment_id, e.event_id
FROM fame_payment_orders o
JOIN fame_reservations r ON r.id = o.reservation_id AND r.market_id = o.market_id
JOIN fame_applications a ON a.id = r.application_id AND a.market_id = r.market_id
JOIN LATERAL (
  SELECT e.event_id FROM fame_square_webhook_events e
  WHERE e.payment_order_id = o.id AND e.square_environment = o.square_environment
    AND e.merchant_id = o.square_merchant_id AND e.location_id = o.square_location_id
    AND e.square_order_id = o.square_order_id AND e.payment_id = o.payment_id
    AND e.payment_status = 'COMPLETED' AND e.disposition = 'paid'
    AND e.amount_cents = o.expected_total_cents AND e.currency = o.expected_currency
    AND e.reconciled_at IS NOT NULL
  ORDER BY e.received_at, e.event_id LIMIT 1
) e ON true
WHERE o.status = 'paid' AND o.payment_status = 'COMPLETED'
  AND o.payment_id IS NOT NULL AND o.payment_received_at IS NOT NULL
  AND r.state = 'paid' AND r.revision = o.reservation_revision
  AND r.total_cents = o.expected_total_cents AND r.currency = o.expected_currency
  AND r.payment_required AND a.opportunity_id IS NOT NULL;

CREATE OR REPLACE FUNCTION fame_enqueue_payment_paid_sync(p_order_id TEXT)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE inserted_count INTEGER;
BEGIN
  INSERT INTO fame_payment_paid_sync_outbox
    (payment_order_id, market_id, application_id, location_id, contact_id,
     opportunity_id, season_id, reservation_id, reservation_revision,
     square_environment, square_merchant_id, square_location_id,
     square_order_id, payment_id, event_id)
  SELECT payment_order_id, market_id, application_id, location_id, contact_id,
         opportunity_id, season_id, reservation_id, reservation_revision,
         square_environment, square_merchant_id, square_location_id,
         square_order_id, payment_id, event_id
  FROM fame_payment_paid_sync_eligible WHERE payment_order_id = p_order_id
  ON CONFLICT (payment_order_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;
CREATE OR REPLACE FUNCTION fame_queue_payment_paid_sync()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'paid' THEN PERFORM fame_enqueue_payment_paid_sync(NEW.id); END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS fame_payment_paid_sync_enqueue ON fame_payment_orders;
CREATE CONSTRAINT TRIGGER fame_payment_paid_sync_enqueue
  AFTER INSERT OR UPDATE OF status ON fame_payment_orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION fame_queue_payment_paid_sync();

CREATE OR REPLACE FUNCTION fame_payment_paid_sync_identity_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','attempts','next_attempt_at','locked_until','lease_token','delivered_at','last_error_code','updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','attempts','next_attempt_at','locked_until','lease_token','delivered_at','last_error_code','updated_at']) THEN
    RAISE EXCEPTION 'Paid sync identity cannot be reassigned';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS fame_payment_paid_sync_identity_guard ON fame_payment_paid_sync_outbox;
CREATE TRIGGER fame_payment_paid_sync_identity_guard
  BEFORE UPDATE ON fame_payment_paid_sync_outbox FOR EACH ROW
  EXECUTE FUNCTION fame_payment_paid_sync_identity_guard();
COMMIT;
