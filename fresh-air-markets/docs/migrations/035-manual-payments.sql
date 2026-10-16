-- Payments staff take outside the portal (for example a payment request sent
-- from the Square app on a phone) and record against a booking.
--
-- Apply after 034. They count toward the vendor's balance like any other
-- payment; when payments cover what the booking owes it becomes paid. A
-- mistaken entry is voided, never deleted.
BEGIN;

CREATE TABLE IF NOT EXISTS fame_manual_payments (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  application_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  paid_on DATE NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 300),
  marked_booking_paid BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_account_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  FOREIGN KEY (application_id, market_id) REFERENCES fame_applications(id, market_id),
  FOREIGN KEY (reservation_id, market_id) REFERENCES fame_reservations(id, market_id)
);
CREATE INDEX IF NOT EXISTS fame_manual_payments_reservation_idx ON fame_manual_payments(market_id, reservation_id);
CREATE INDEX IF NOT EXISTS fame_manual_payments_application_idx ON fame_manual_payments(market_id, application_id);

COMMIT;
