-- Payment links that stay open.
--
-- Apply after 030. The market no longer cancels a payment link on its own
-- after 48 hours (FAME_PAYMENT_AUTO_EXPIRY is off unless set to "true");
-- staff release an unpaid booking with "Withdraw this booking". An emailed
-- link therefore has to outlive the old seven-day ceiling. Browser sessions
-- keep their seven-day limit.
BEGIN;

DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'fame_vendor_payment_invitations'::regclass AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%7 days%'
  LOOP
    EXECUTE format('ALTER TABLE fame_vendor_payment_invitations DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE fame_vendor_payment_invitations
  DROP CONSTRAINT IF EXISTS fame_vendor_payment_invitations_lifetime_check;
ALTER TABLE fame_vendor_payment_invitations
  ADD CONSTRAINT fame_vendor_payment_invitations_lifetime_check
  CHECK (expires_at <= created_at + INTERVAL '400 days');

-- The same emailed link may be opened again later or on another device, so
-- one invitation can back more than one browser session.
ALTER TABLE fame_vendor_payment_sessions
  DROP CONSTRAINT IF EXISTS fame_vendor_payment_sessions_invitation_hash_key;
CREATE INDEX IF NOT EXISTS fame_vendor_payment_sessions_invitation_idx
  ON fame_vendor_payment_sessions(invitation_hash);

COMMIT;
