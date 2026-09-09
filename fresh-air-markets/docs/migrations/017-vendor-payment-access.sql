-- Separate, hash-only vendor invitations/sessions. No manager cookie, email,
-- application snapshot or provider credential is persisted here. Apply after 013.
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fame_reservations_access_revision_key'
    AND conrelid = 'fame_reservations'::regclass) THEN
    ALTER TABLE fame_reservations ADD CONSTRAINT fame_reservations_access_revision_key UNIQUE (id, market_id, revision);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS fame_vendor_payment_invitations (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  market_id TEXT NOT NULL REFERENCES accounts(id),
  reservation_id TEXT NOT NULL,
  reservation_revision INTEGER NOT NULL CHECK (reservation_revision >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  UNIQUE (token_hash, market_id, reservation_id, reservation_revision),
  FOREIGN KEY (reservation_id, market_id)
    REFERENCES fame_reservation_finalizations(reservation_id, market_id),
  FOREIGN KEY (reservation_id, market_id, reservation_revision)
    REFERENCES fame_reservations(id, market_id, revision),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + INTERVAL '7 days')
);

CREATE UNIQUE INDEX IF NOT EXISTS fame_vendor_payment_one_active_invitation_idx
  ON fame_vendor_payment_invitations(market_id, reservation_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS fame_vendor_payment_sessions (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  invitation_hash TEXT NOT NULL,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  reservation_id TEXT NOT NULL,
  reservation_revision INTEGER NOT NULL CHECK (reservation_revision >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  UNIQUE (invitation_hash),
  FOREIGN KEY (invitation_hash, market_id, reservation_id, reservation_revision)
    REFERENCES fame_vendor_payment_invitations(token_hash, market_id, reservation_id, reservation_revision),
  CHECK (token_hash <> invitation_hash),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + INTERVAL '7 days')
);

CREATE INDEX IF NOT EXISTS fame_vendor_payment_sessions_reservation_idx
  ON fame_vendor_payment_sessions(market_id, reservation_id) WHERE revoked_at IS NULL;

COMMIT;
