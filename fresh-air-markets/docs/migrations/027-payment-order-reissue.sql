-- A reservation may need a second Square payment request after its first
-- hold expired and staff reopened it. Orders stay one-per-revision while
-- live; expired orders no longer block a replacement. Every order keeps its
-- own idempotency key, so Square never sees two links for one live attempt.
BEGIN;

ALTER TABLE fame_payment_orders
  DROP CONSTRAINT IF EXISTS fame_payment_orders_reservation_id_reservation_revision_key;
CREATE UNIQUE INDEX IF NOT EXISTS fame_payment_orders_live_revision_idx
  ON fame_payment_orders(reservation_id, reservation_revision)
  WHERE status <> 'expired';

COMMIT;
