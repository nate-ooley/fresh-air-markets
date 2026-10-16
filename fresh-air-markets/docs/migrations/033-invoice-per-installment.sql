-- One Square invoice per scheduled payment.
--
-- Apply after 032. Square only allows installment invoices on its paid
-- Invoices Plus plan, so a monthly plan is sent as one ordinary invoice per
-- payment, each scheduled by Square for its own date. Each installment row
-- now carries its own Square order and invoice; payments are matched to the
-- installment's order. Plans written before this update keep their single
-- invoice on fame_invoices.
BEGIN;

ALTER TABLE fame_invoice_installments ADD COLUMN IF NOT EXISTS square_order_id TEXT;
ALTER TABLE fame_invoice_installments ADD COLUMN IF NOT EXISTS square_invoice_id TEXT;
ALTER TABLE fame_invoice_installments ADD COLUMN IF NOT EXISTS square_invoice_version INTEGER;
ALTER TABLE fame_invoice_installments ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE fame_invoice_installments ADD COLUMN IF NOT EXISTS public_url TEXT;
ALTER TABLE fame_invoice_installments ADD COLUMN IF NOT EXISTS paid_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE fame_invoice_installments ADD COLUMN IF NOT EXISTS cancelled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS fame_invoice_installments_square_order
  ON fame_invoice_installments(square_order_id) WHERE square_order_id IS NOT NULL;

ALTER TABLE fame_invoice_payments ADD COLUMN IF NOT EXISTS installment_seq INTEGER;

COMMIT;
