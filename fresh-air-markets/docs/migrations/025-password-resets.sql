-- Single-use, time-limited password reset tokens for market staff accounts.
-- Only the SHA-256 of the emailed token is stored; a row is spent by setting
-- used_at, and requesting a new reset supersedes any unused earlier rows.
BEGIN;

CREATE TABLE IF NOT EXISTS fame_password_resets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  token_hash TEXT NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fame_password_resets_account_idx ON fame_password_resets(account_id, created_at DESC);

COMMIT;
