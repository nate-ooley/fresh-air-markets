-- Internal market-manager notes on a vendor.
--
-- Apply after 035. Notes belong to the application, so they are available at
-- every stage (before approval, before payment, after withdrawal). They are
-- staff-only and never appear in anything sent to a vendor. A removed note is
-- marked removed, not deleted.
BEGIN;

CREATE TABLE IF NOT EXISTS fame_vendor_notes (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  application_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  author_name TEXT NOT NULL CHECK (char_length(author_name) BETWEEN 1 AND 200),
  created_by_account_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  FOREIGN KEY (application_id, market_id) REFERENCES fame_applications(id, market_id)
);
CREATE INDEX IF NOT EXISTS fame_vendor_notes_application_idx ON fame_vendor_notes(market_id, application_id, created_at DESC);

COMMIT;
