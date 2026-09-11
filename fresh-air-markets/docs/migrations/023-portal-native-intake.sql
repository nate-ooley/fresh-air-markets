-- Portal-native intake: the marketing site and vendor application live in this
-- app, with no CRM in the loop. Applications still land in fame_applications
-- through the existing handoff writer; these tables add the agreement signature
-- record the reservation gate references, plus contact and newsletter capture.
BEGIN;

CREATE TABLE IF NOT EXISTS fame_agreement_signatures (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES fame_applications(id),
  market_id TEXT NOT NULL REFERENCES accounts(id),
  agreement_version TEXT NOT NULL,
  signer_name TEXT NOT NULL CHECK (char_length(signer_name) BETWEEN 2 AND 200),
  signer_email TEXT NOT NULL CHECK (char_length(signer_email) BETWEEN 3 AND 254),
  client_ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fame_agreement_signatures_application_idx
  ON fame_agreement_signatures(application_id, signed_at DESC);

CREATE TABLE IF NOT EXISTS fame_contact_messages (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  phone TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL CHECK (topic IN ('general', 'vendor', 'nonprofit')),
  message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 4000),
  client_ip TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS fame_contact_messages_market_idx
  ON fame_contact_messages(market_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fame_newsletter_subscribers (
  market_id TEXT NOT NULL REFERENCES accounts(id),
  email TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (market_id, email)
);

COMMIT;
