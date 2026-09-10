-- Durable retry scheduling for Square hosted-link retirement.
--
-- Apply after 014-square-payment-expiry.sql. A transient provider failure must
-- not make the same pending retirement eligible again during the current
-- scheduler invocation. This field is the shared retry clock for every worker.
BEGIN;

ALTER TABLE fame_square_payment_link_retirements
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

-- A previous draft could have marked the retirement record `retired` without
-- sufficient Square cancellation evidence. Do not infer proof from its parent
-- or backfill an order ID. Quarantine every such row and any still-active
-- parent order/reservation before the retry schedule is enabled.
UPDATE fame_reservations r
SET state = 'manual_review', updated_at = now()
FROM fame_payment_orders p
JOIN fame_square_payment_link_retirements q ON q.payment_order_id = p.id
WHERE r.id = p.reservation_id
  AND r.market_id = p.market_id
  AND q.status = 'retired'
  AND (
    q.retired_at IS NULL
    OR q.retired_square_order_id IS NULL
    OR q.retired_square_order_id IS DISTINCT FROM q.square_order_id
  )
  AND r.state IN ('held', 'payment_pending', 'expired');

UPDATE fame_payment_orders p
SET status = 'manual_review',
    locked_until = NULL,
    lease_token = NULL,
    last_error_code = 'legacy_retired_without_cancellation_proof',
    updated_at = now()
FROM fame_square_payment_link_retirements q
WHERE q.payment_order_id = p.id
  AND q.status = 'retired'
  AND (
    q.retired_at IS NULL
    OR q.retired_square_order_id IS NULL
    OR q.retired_square_order_id IS DISTINCT FROM q.square_order_id
  )
  AND p.status IN ('pending_checkout', 'processing_checkout', 'checkout_created', 'expiry_pending', 'expired');

UPDATE fame_square_payment_link_retirements q
SET status = 'manual_review',
    locked_until = NULL,
    lease_token = NULL,
    next_attempt_at = NULL,
    retired_at = NULL,
    retired_square_order_id = NULL,
    last_error_code = 'legacy_retired_without_cancellation_proof',
    updated_at = now()
WHERE q.status = 'retired'
  AND (
    q.retired_at IS NULL
    OR q.retired_square_order_id IS NULL
    OR q.retired_square_order_id IS DISTINCT FROM q.square_order_id
  );

-- Existing pending work was created before a retry clock existed, so make it
-- eligible immediately once on upgrade. Every non-pending terminal/leased row
-- must not retain a future retry timestamp.
UPDATE fame_square_payment_link_retirements
SET next_attempt_at = now()
WHERE status = 'pending' AND next_attempt_at IS NULL;

UPDATE fame_square_payment_link_retirements
SET next_attempt_at = NULL
WHERE status <> 'pending' AND next_attempt_at IS NOT NULL;

ALTER TABLE fame_square_payment_link_retirements
  DROP CONSTRAINT IF EXISTS fame_square_payment_link_retirements_next_attempt_check;
ALTER TABLE fame_square_payment_link_retirements
  ADD CONSTRAINT fame_square_payment_link_retirements_next_attempt_check CHECK (
    (status = 'pending' AND next_attempt_at IS NOT NULL)
    OR (status <> 'pending' AND next_attempt_at IS NULL)
  );

-- Replace the pre-schedule index with one that makes due pending work and
-- expired leases selectable without scanning future retries.
DROP INDEX IF EXISTS fame_square_payment_link_retirements_ready_idx;
CREATE INDEX fame_square_payment_link_retirements_ready_idx
  ON fame_square_payment_link_retirements(status, next_attempt_at, locked_until, created_at)
  WHERE status IN ('pending', 'processing');

COMMIT;
