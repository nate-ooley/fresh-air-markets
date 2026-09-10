-- Additive migration. Run against the portal database after its accounts schema
-- exists. Never point this at a different business's database.
BEGIN;
CREATE TABLE IF NOT EXISTS fame_applications (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  location_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  opportunity_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (market_id, location_id, contact_id, season_id)
);
CREATE TABLE IF NOT EXISTS fame_application_events (
  location_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  application_id TEXT REFERENCES fame_applications(id),
  payload_hash TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, event_id)
);
CREATE INDEX IF NOT EXISTS fame_application_events_application_idx
  ON fame_application_events(application_id, created_at);
COMMIT;
