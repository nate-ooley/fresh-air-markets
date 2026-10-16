-- Discounts and credits on a vendor's rolling balance.
--
-- Apply after 033. A discount lowers one unpaid booking's price. A credit
-- (for example a rain-out) sits on the vendor's balance until staff use it
-- on a booking, which records a credit_applied row against that booking.
-- Every row keeps who made it and why; a mistaken row is voided, never
-- deleted, so the balance history stays complete.
BEGIN;

CREATE TABLE IF NOT EXISTS fame_vendor_adjustments (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  application_id TEXT NOT NULL,
  reservation_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('discount', 'credit', 'credit_applied')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  percent NUMERIC(5, 2) CHECK (percent IS NULL OR (percent > 0 AND percent <= 100)),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  created_by_account_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  FOREIGN KEY (application_id, market_id) REFERENCES fame_applications(id, market_id),
  FOREIGN KEY (reservation_id, market_id) REFERENCES fame_reservations(id, market_id),
  CHECK ((kind = 'credit') = (reservation_id IS NULL))
);
CREATE INDEX IF NOT EXISTS fame_vendor_adjustments_application_idx ON fame_vendor_adjustments(market_id, application_id, created_at);
CREATE INDEX IF NOT EXISTS fame_vendor_adjustments_reservation_idx ON fame_vendor_adjustments(market_id, reservation_id) WHERE reservation_id IS NOT NULL;

COMMIT;
