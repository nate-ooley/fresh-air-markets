-- Several bookings per vendor and manager withdrawal.
--
-- Apply after 028. An approved application is the vendor's profile for the
-- season; each CHECK -> RESERVE writes one more immutable booking for it. A
-- manager can withdraw an unpaid booking (or the whole application) at the
-- vendor's request. Paid and confirmed bookings stay locked.
BEGIN;

-- Migration 013 allowed exactly one finalization per application. Drop that
-- rule (whatever name Postgres gave it) but keep every other key.
DO $$
DECLARE constraint_name TEXT;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  WHERE c.conrelid = 'fame_reservation_finalizations'::regclass
    AND c.contype = 'u'
    AND (
      SELECT array_agg(a.attname::text ORDER BY a.attname)
      FROM unnest(c.conkey) AS k(attnum)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    ) = ARRAY['application_id', 'market_id'];
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE fame_reservation_finalizations DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fame_reservation_finalizations_application_idx
  ON fame_reservation_finalizations(market_id, application_id, created_at);

-- A withdrawn booking is 'cancelled' (already a legal state, already excluded
-- from capacity and the roster). These columns record who asked and why.
ALTER TABLE fame_reservations
  ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;
ALTER TABLE fame_reservations
  ADD COLUMN IF NOT EXISTS withdrawal_note TEXT;
ALTER TABLE fame_reservations
  DROP CONSTRAINT IF EXISTS fame_reservations_withdrawal_note_check;
ALTER TABLE fame_reservations
  ADD CONSTRAINT fame_reservations_withdrawal_note_check
  CHECK (withdrawal_note IS NULL OR char_length(withdrawal_note) <= 500);

-- A vendor who withdraws for the season leaves the working list without being
-- declined. 'withdrawn' is terminal like 'approved' and 'declined'.
ALTER TABLE fame_applications
  DROP CONSTRAINT IF EXISTS fame_applications_review_state_check;
ALTER TABLE fame_applications
  ADD CONSTRAINT fame_applications_review_state_check
  CHECK (review_state IN ('unreviewed', 'needs_review', 'changes_requested', 'approved', 'declined', 'withdrawn'));

COMMIT;
