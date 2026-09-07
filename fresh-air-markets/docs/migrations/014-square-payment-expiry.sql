-- Durable expiry-claim and hosted-link retirement for Square Sandbox holds.
--
-- Apply after 011-square-payment-checkout-ledger.sql, 012-square-webhook-events.sql,
-- and 013-final-reservation-writer.sql. The deadline transaction claims a
-- hold for provider retirement; capacity is released only after Square
-- confirms the hosted link is deleted. Immutable allocation rows remain audit
-- evidence throughout.
BEGIN;

-- Checkout migration 011 deliberately permits only known payment lifecycle
-- states. `expiry_pending` is a fenced, non-payable state while the provider
-- link is deleted, so a still-live link cannot race a released allocation.
ALTER TABLE fame_payment_orders
  DROP CONSTRAINT IF EXISTS fame_payment_orders_status_check;
ALTER TABLE fame_payment_orders
  ADD CONSTRAINT fame_payment_orders_status_check CHECK (status IN (
    'pending_checkout', 'processing_checkout', 'checkout_created', 'expiry_pending',
    'paid', 'expired', 'cancelled', 'manual_review', 'failed'
  ));

CREATE TABLE IF NOT EXISTS fame_square_payment_link_retirements (
  payment_order_id TEXT PRIMARY KEY REFERENCES fame_payment_orders(id),
  market_id TEXT NOT NULL REFERENCES accounts(id),
  square_environment TEXT NOT NULL CHECK (square_environment = 'sandbox'),
  square_merchant_id TEXT NOT NULL,
  square_location_id TEXT NOT NULL,
  square_payment_link_id TEXT NOT NULL,
  square_order_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'retired', 'manual_review'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  locked_until TIMESTAMPTZ,
  lease_token TEXT,
  last_error_code TEXT,
  retired_square_order_id TEXT,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (status = 'retired' AND retired_at IS NOT NULL
      AND retired_square_order_id IS NOT NULL
      AND retired_square_order_id = square_order_id)
    OR (status <> 'retired' AND retired_at IS NULL
      AND retired_square_order_id IS NULL)
  ),
  CHECK (
    (status = 'processing' AND locked_until IS NOT NULL AND lease_token IS NOT NULL)
    OR (status <> 'processing' AND locked_until IS NULL AND lease_token IS NULL)
  )
);

-- This migration may be reapplied to a QA database that received an earlier
-- draft. Backfill only from the immutable parent order, then require the
-- exact order proof before any retirement can be marked complete.
ALTER TABLE fame_square_payment_link_retirements
  ADD COLUMN IF NOT EXISTS square_order_id TEXT;
ALTER TABLE fame_square_payment_link_retirements
  ADD COLUMN IF NOT EXISTS retired_square_order_id TEXT;
UPDATE fame_square_payment_link_retirements q
SET square_order_id = p.square_order_id
FROM fame_payment_orders p
WHERE p.id = q.payment_order_id AND q.square_order_id IS NULL;
-- Never fabricate cancellation proof for an older draft row. Quarantine it
-- with the reservation/order so its allocation remains held for an operator
-- to reconcile against Square. The warning makes a partial draft upgrade
-- visible in migration logs without pretending a provider cancellation.
DO $$
DECLARE quarantined_count INTEGER;
BEGIN
  UPDATE fame_reservations r
  SET state = 'manual_review', updated_at = now()
  FROM fame_payment_orders p
  JOIN fame_square_payment_link_retirements q ON q.payment_order_id = p.id
  WHERE r.id = p.reservation_id AND r.market_id = p.market_id
    AND q.status = 'retired' AND q.retired_square_order_id IS NULL
    AND r.state = 'expired';
  UPDATE fame_payment_orders p
  SET status = 'manual_review', last_error_code = 'legacy_retired_without_cancellation_proof',
      updated_at = now()
  FROM fame_square_payment_link_retirements q
  WHERE q.payment_order_id = p.id
    AND q.status = 'retired' AND q.retired_square_order_id IS NULL
    AND p.status = 'expired';
  UPDATE fame_square_payment_link_retirements
  SET status = 'manual_review', retired_at = NULL, retired_square_order_id = NULL,
      last_error_code = 'legacy_retired_without_cancellation_proof', updated_at = now()
  WHERE status = 'retired' AND retired_square_order_id IS NULL;
  GET DIAGNOSTICS quarantined_count = ROW_COUNT;
  IF quarantined_count > 0 THEN
    RAISE WARNING 'Quarantined % legacy Square retirement rows without cancellation proof; reconcile in Square before release.', quarantined_count;
  END IF;
END $$;
ALTER TABLE fame_square_payment_link_retirements
  ALTER COLUMN square_order_id SET NOT NULL;
ALTER TABLE fame_square_payment_link_retirements
  DROP CONSTRAINT IF EXISTS fame_square_payment_link_retirements_retired_proof_check;
ALTER TABLE fame_square_payment_link_retirements
  ADD CONSTRAINT fame_square_payment_link_retirements_retired_proof_check CHECK (
    (status = 'retired' AND retired_at IS NOT NULL
      AND retired_square_order_id IS NOT NULL
      AND retired_square_order_id = square_order_id)
    OR (status <> 'retired' AND retired_at IS NULL
      AND retired_square_order_id IS NULL)
  );

CREATE INDEX IF NOT EXISTS fame_square_payment_link_retirements_ready_idx
  ON fame_square_payment_link_retirements(status, locked_until, created_at)
  WHERE status IN ('pending', 'processing');

-- A retirement record is derived only by the expiry transaction. Its stored
-- merchant/location/link identifiers make retries independent of a browser
-- or mutable reservation payload and let the worker fence a configured Square
-- identity before it sends DELETE to the provider.
CREATE INDEX IF NOT EXISTS fame_square_payment_link_retirements_identity_idx
  ON fame_square_payment_link_retirements(
    square_environment, square_merchant_id, square_location_id, status, created_at
  );

COMMIT;
