-- Durable Square webhook receipt and reconciliation ledger.
-- Apply after 011-square-payment-checkout-ledger.sql. The raw webhook body is never
-- stored: the SHA-256 digest is sufficient to detect altered event-ID reuse.
-- A payment state change and its receipt must be committed in one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS fame_square_webhook_events (
  square_environment TEXT NOT NULL CHECK (square_environment IN ('sandbox', 'production')),
  event_id TEXT NOT NULL,
  payment_order_id TEXT REFERENCES fame_payment_orders(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('payment.created', 'payment.updated')),
  merchant_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  square_order_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at TIMESTAMPTZ,
  payment_created_at TIMESTAMPTZ,
  payment_updated_at TIMESTAMPTZ,
  raw_body_sha256 TEXT NOT NULL CHECK (raw_body_sha256 ~ '^[a-f0-9]{64}$'),
  disposition TEXT NOT NULL CHECK (disposition IN ('paid', 'ignored', 'manual_review')),
  manual_review_reason TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_at TIMESTAMPTZ,
  PRIMARY KEY (square_environment, event_id)
);

CREATE INDEX IF NOT EXISTS fame_square_webhook_events_order_idx
  ON fame_square_webhook_events(payment_order_id, received_at DESC);
CREATE INDEX IF NOT EXISTS fame_square_webhook_events_review_idx
  ON fame_square_webhook_events(disposition, received_at DESC)
  WHERE disposition = 'manual_review';
CREATE INDEX IF NOT EXISTS fame_square_webhook_events_payment_idx
  ON fame_square_webhook_events(square_environment, payment_id, received_at DESC);

COMMIT;
