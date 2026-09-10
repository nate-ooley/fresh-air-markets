-- Private object store for application documents (insurance, food license).
-- Bytes live only in this table; the document ledger (006) keeps references,
-- digests and review state. Rows are written by the server-side transfer
-- primitive after streaming and inspection; nothing here is publicly addressable.
BEGIN;

CREATE TABLE IF NOT EXISTS fame_private_document_objects (
  storage_key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  body BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
