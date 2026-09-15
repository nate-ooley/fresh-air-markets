-- Follow-up to 027: a failed or cancelled attempt must not block the next
-- payment request for a reopened hold either. Only a live attempt (processing,
-- checkout created, expiry pending, paid) holds the one-per-revision slot.
BEGIN;

DROP INDEX IF EXISTS fame_payment_orders_live_revision_idx;
CREATE UNIQUE INDEX IF NOT EXISTS fame_payment_orders_live_revision_idx
  ON fame_payment_orders(reservation_id, reservation_revision)
  WHERE status NOT IN ('expired', 'failed', 'cancelled');

COMMIT;
