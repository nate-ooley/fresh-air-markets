-- Terminal, inspectable failures for exact agreement-stage delivery.
-- Apply after 007-agreement-completion-stage-outbox.sql. A failed row is never
-- claimed automatically; an operator must correct its mapping before requeueing.
BEGIN;

ALTER TABLE fame_agreement_stage_outbox
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

ALTER TABLE fame_agreement_stage_outbox
  DROP CONSTRAINT IF EXISTS fame_agreement_stage_outbox_status_check;

ALTER TABLE fame_agreement_stage_outbox
  ADD CONSTRAINT fame_agreement_stage_outbox_status_check
  CHECK (status IN ('pending', 'processing', 'delivered', 'failed'));

CREATE INDEX IF NOT EXISTS fame_agreement_stage_outbox_failed_idx
  ON fame_agreement_stage_outbox(status, failed_at)
  WHERE status = 'failed';

COMMIT;
