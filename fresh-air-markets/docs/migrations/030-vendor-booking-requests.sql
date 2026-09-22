-- Vendor self-serve "book more dates" requests and insurance expiry.
--
-- Apply after 029. A vendor with an approved application asks for more
-- Saturdays from a personal link; staff confirm the request with one click,
-- which writes the booking and sends the payment link. Staff record when a
-- certificate of insurance expires so no date past it can be booked until a
-- fresh certificate is on file.
BEGIN;

ALTER TABLE fame_application_documents
  ADD COLUMN IF NOT EXISTS expires_on DATE;

CREATE TABLE IF NOT EXISTS fame_booking_requests (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL REFERENCES accounts(id),
  application_id TEXT NOT NULL,
  requested_dates JSONB NOT NULL,
  booths_per_market INTEGER NOT NULL CHECK (booths_per_market BETWEEN 1 AND 4),
  vendor_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined', 'withdrawn')),
  -- Set when staff confirm: the booking this request became.
  reservation_id TEXT,
  staff_note TEXT,
  decided_at TIMESTAMPTZ,
  decided_by_account_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (application_id, market_id) REFERENCES fame_applications(id, market_id),
  FOREIGN KEY (reservation_id, market_id) REFERENCES fame_reservations(id, market_id),
  CHECK (jsonb_typeof(requested_dates) = 'array' AND jsonb_array_length(requested_dates) BETWEEN 1 AND 35),
  CHECK (char_length(vendor_note) <= 1000),
  CHECK (staff_note IS NULL OR char_length(staff_note) <= 1000),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status <> 'confirmed' OR reservation_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS fame_booking_requests_market_status_idx
  ON fame_booking_requests(market_id, status, created_at);

-- A vendor has at most one open request at a time.
CREATE UNIQUE INDEX IF NOT EXISTS fame_booking_requests_open_idx
  ON fame_booking_requests(market_id, application_id)
  WHERE status = 'pending';

COMMIT;
