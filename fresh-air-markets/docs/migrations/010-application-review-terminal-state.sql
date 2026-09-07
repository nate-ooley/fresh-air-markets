-- Terminal, inspectable failures for exact application-review delivery.
-- Apply after 004-application-review-outbox.sql. Failed rows are not retried
-- automatically; an operator must correct the HighLevel mapping before requeueing.
BEGIN;

ALTER TABLE fame_application_outbox
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

ALTER TABLE fame_application_outbox
  DROP CONSTRAINT IF EXISTS fame_application_outbox_status_check;

ALTER TABLE fame_application_outbox
  ADD CONSTRAINT fame_application_outbox_status_check
  CHECK (status IN ('pending', 'processing', 'delivered', 'failed'));

CREATE INDEX IF NOT EXISTS fame_application_outbox_failed_idx
  ON fame_application_outbox(status, failed_at)
  WHERE status = 'failed';

COMMIT;
