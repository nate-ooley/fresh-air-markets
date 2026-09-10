-- Additive receipt ledger. Apply to the reviewed production database before
-- enabling clients that require Idempotency-Key. No existing records change.
CREATE TABLE IF NOT EXISTS inquiry_requests (
  market_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (market_id, request_key)
);
-- Keep receipts while their bookings are retained. Never expire a receipt while
-- retaining its booking: doing so could turn an old retry into a new application.
