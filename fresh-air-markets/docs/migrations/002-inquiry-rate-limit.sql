-- Additive migration; contains no applicant data and modifies no booking state.
CREATE TABLE IF NOT EXISTS fame_inquiry_limits (
  bucket_key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL CHECK (hits > 0),
  resets_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS fame_inquiry_limits_expiry ON fame_inquiry_limits (resets_at);

-- Run daily in database maintenance. Never delete an active bucket:
-- DELETE FROM fame_inquiry_limits WHERE resets_at < now() - interval '1 day';
