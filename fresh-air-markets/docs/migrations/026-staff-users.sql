-- Individual staff logins for a market. The accounts row stays the market
-- (tenant); fame_staff_users holds the people who may sign in to it. The
-- existing account login is carried over as that market's owner so nothing
-- changes for it. Password-reset rows learn which staff user they belong to
-- and whether they are a reset or an invitation.
BEGIN;

CREATE TABLE IF NOT EXISTS fame_staff_users (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  email TEXT NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  name TEXT NOT NULL DEFAULT '' CHECK (char_length(name) <= 120),
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'removed')),
  password_hash TEXT,
  invited_by TEXT REFERENCES fame_staff_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (market_id, email)
);
CREATE INDEX IF NOT EXISTS fame_staff_users_active_email_idx ON fame_staff_users(email) WHERE status = 'active';

ALTER TABLE fame_password_resets ADD COLUMN IF NOT EXISTS staff_user_id TEXT REFERENCES fame_staff_users(id);
ALTER TABLE fame_password_resets ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'reset' CHECK (purpose IN ('reset', 'invite'));

-- Carry each existing market login over as its owner. Test fixtures may
-- create a minimal accounts table without login columns; skip the copy there.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'accounts' AND column_name = 'password_hash'
  ) THEN
    INSERT INTO fame_staff_users (id, market_id, email, name, role, status, password_hash)
    SELECT 'staff-' || id, id, lower(email), owner_name, 'owner', 'active', password_hash FROM accounts
    ON CONFLICT (market_id, email) DO NOTHING;
  END IF;
END $$;

COMMIT;
