-- Staff billing through Square Invoices: one payment or a monthly plan.
--
-- Apply after 031. A booking billed this way keeps its reservation row; the
-- invoice records what staff chose (amount, reason when it differs from the
-- quote, schedule) and every Square payment that arrives against the
-- invoice's order. The booking becomes "paid" only when the payments cover
-- the invoice total. At most one live invoice per booking.
BEGIN;

CREATE TABLE IF NOT EXISTS fame_invoices (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  reservation_id TEXT NOT NULL,
  square_environment TEXT NOT NULL CHECK (square_environment IN ('sandbox', 'production')),
  plan TEXT NOT NULL CHECK (plan IN ('full', 'monthly')),
  total_cents BIGINT NOT NULL CHECK (total_cents >= 100),
  quoted_cents BIGINT NOT NULL CHECK (quoted_cents >= 0),
  adjustment_reason TEXT NOT NULL DEFAULT '' CHECK (char_length(adjustment_reason) <= 300),
  status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'paid', 'cancelled', 'failed')),
  paid_cents BIGINT NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  square_customer_id TEXT,
  square_order_id TEXT,
  square_invoice_id TEXT,
  square_invoice_version INTEGER,
  public_url TEXT,
  last_error TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  created_by_account_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (reservation_id, market_id) REFERENCES fame_reservations(id, market_id),
  CHECK (total_cents = quoted_cents OR adjustment_reason <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS fame_invoices_one_live_per_booking
  ON fame_invoices(market_id, reservation_id) WHERE status IN ('creating', 'open');
CREATE UNIQUE INDEX IF NOT EXISTS fame_invoices_square_order
  ON fame_invoices(square_environment, square_order_id) WHERE square_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS fame_invoice_installments (
  invoice_id TEXT NOT NULL REFERENCES fame_invoices(id),
  seq INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 12),
  due_on DATE NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 100),
  PRIMARY KEY (invoice_id, seq)
);

CREATE TABLE IF NOT EXISTS fame_invoice_payments (
  square_environment TEXT NOT NULL CHECK (square_environment IN ('sandbox', 'production')),
  payment_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES fame_invoices(id),
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (square_environment, payment_id)
);
CREATE INDEX IF NOT EXISTS fame_invoice_payments_invoice_idx ON fame_invoice_payments(invoice_id);

COMMIT;
