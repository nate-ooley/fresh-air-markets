-- Stage-only acknowledgements are not custom-field delivery proof. No CRM calls.
-- Apply with old workers paused. Legacy successful/in-flight work is fenced and
-- revalidated by the new workers; current eligibility cancels obsolete payments.
BEGIN;

ALTER TABLE fame_agreement_stage_outbox ADD COLUMN IF NOT EXISTS delivery_receipt JSONB;
ALTER TABLE fame_agreement_stage_outbox ADD COLUMN IF NOT EXISTS legacy_delivery_receipt JSONB;
ALTER TABLE fame_payment_pending_sync_outbox ADD COLUMN IF NOT EXISTS delivery_receipt JSONB;
ALTER TABLE fame_payment_pending_sync_outbox ADD COLUMN IF NOT EXISTS legacy_delivery_receipt JSONB;
ALTER TABLE fame_payment_paid_sync_outbox ADD COLUMN IF NOT EXISTS delivery_receipt JSONB;
ALTER TABLE fame_payment_paid_sync_outbox ADD COLUMN IF NOT EXISTS legacy_delivery_receipt JSONB;

CREATE OR REPLACE FUNCTION fame_payment_pending_sync_identity_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','attempts','next_attempt_at','locked_until','lease_token','delivered_at','last_error_code','updated_at','delivery_receipt','legacy_delivery_receipt'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','attempts','next_attempt_at','locked_until','lease_token','delivered_at','last_error_code','updated_at','delivery_receipt','legacy_delivery_receipt']) THEN
    RAISE EXCEPTION 'Pending sync identity cannot be reassigned';
  END IF;
  IF OLD.legacy_delivery_receipt IS NOT NULL AND NEW.legacy_delivery_receipt IS DISTINCT FROM OLD.legacy_delivery_receipt THEN
    RAISE EXCEPTION 'Legacy delivery history cannot be reassigned';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fame_payment_paid_sync_identity_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','attempts','next_attempt_at','locked_until','lease_token','delivered_at','last_error_code','updated_at','delivery_receipt','legacy_delivery_receipt'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','attempts','next_attempt_at','locked_until','lease_token','delivered_at','last_error_code','updated_at','delivery_receipt','legacy_delivery_receipt']) THEN
    RAISE EXCEPTION 'Paid sync identity cannot be reassigned';
  END IF;
  IF OLD.legacy_delivery_receipt IS NOT NULL AND NEW.legacy_delivery_receipt IS DISTINCT FROM OLD.legacy_delivery_receipt THEN
    RAISE EXCEPTION 'Legacy delivery history cannot be reassigned';
  END IF;
  RETURN NEW;
END;
$$;

UPDATE fame_agreement_stage_outbox SET
  legacy_delivery_receipt = COALESCE(legacy_delivery_receipt, jsonb_build_object('contract','legacy_stage_only','status',status,'deliveredAt',delivered_at,'attempts',attempts)),
  status = 'pending', attempts = 0, delivered_at = NULL, locked_until = NULL, lease_token = NULL,
  next_attempt_at = statement_timestamp(), last_error_code = 'legacy_field_revalidation_required'
WHERE status IN ('delivered','processing') AND delivery_receipt IS NULL;
UPDATE fame_payment_pending_sync_outbox SET
  legacy_delivery_receipt = COALESCE(legacy_delivery_receipt, jsonb_build_object('contract','legacy_stage_only','status',status,'deliveredAt',delivered_at,'attempts',attempts)),
  status = 'pending', attempts = 0, delivered_at = NULL, locked_until = NULL, lease_token = NULL,
  next_attempt_at = statement_timestamp(), last_error_code = 'legacy_field_revalidation_required', updated_at = statement_timestamp()
WHERE status IN ('delivered','processing') AND delivery_receipt IS NULL;
UPDATE fame_payment_paid_sync_outbox SET
  legacy_delivery_receipt = COALESCE(legacy_delivery_receipt, jsonb_build_object('contract','legacy_stage_only','status',status,'deliveredAt',delivered_at,'attempts',attempts)),
  status = 'pending', attempts = 0, delivered_at = NULL, locked_until = NULL, lease_token = NULL,
  next_attempt_at = statement_timestamp(), last_error_code = 'legacy_field_revalidation_required', updated_at = statement_timestamp()
WHERE status IN ('delivered','processing') AND delivery_receipt IS NULL;

CREATE OR REPLACE FUNCTION fame_valid_opportunity_field_receipt(receipt JSONB, location_id TEXT, contact_id TEXT, opportunity_id TEXT, field_values TEXT[])
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(receipt) = 'object'
    AND receipt->>'deliveryContract' = 'ghl_opportunity_fields_v1'
    AND receipt->>'locationId' = location_id AND receipt->>'contactId' = contact_id AND receipt->>'opportunityId' = opportunity_id
    AND receipt->>'pipelineId' ~ '^[A-Za-z0-9_-]{1,192}$'
    AND CASE WHEN jsonb_typeof(receipt->'fields') = 'array' THEN
      jsonb_array_length(receipt->'fields') = cardinality(field_values)
      AND (SELECT count(DISTINCT item->>'fieldId') FROM jsonb_array_elements(receipt->'fields') item) = cardinality(field_values)
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(receipt->'fields') item
        WHERE NOT COALESCE(item->>'fieldId' ~ '^[A-Za-z0-9_-]{1,192}$' AND item->>'fieldValue' = ANY(field_values), FALSE))
      AND NOT EXISTS (SELECT 1 FROM unnest(field_values) wanted
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(receipt->'fields') item WHERE item->>'fieldValue' = wanted))
    ELSE FALSE END, FALSE);
$$;

CREATE OR REPLACE FUNCTION fame_opportunity_field_receipt_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.delivery_receipt IS NOT NULL AND NEW.delivery_receipt IS DISTINCT FROM OLD.delivery_receipt THEN
    RAISE EXCEPTION 'Verified field delivery receipt is immutable';
  END IF;
  IF OLD.legacy_delivery_receipt IS NOT NULL AND NEW.legacy_delivery_receipt IS DISTINCT FROM OLD.legacy_delivery_receipt THEN
    RAISE EXCEPTION 'Legacy delivery history cannot be reassigned';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS fame_agreement_field_receipt_guard ON fame_agreement_stage_outbox;
CREATE TRIGGER fame_agreement_field_receipt_guard BEFORE UPDATE ON fame_agreement_stage_outbox
  FOR EACH ROW EXECUTE FUNCTION fame_opportunity_field_receipt_guard();
DROP TRIGGER IF EXISTS fame_pending_field_receipt_guard ON fame_payment_pending_sync_outbox;
CREATE TRIGGER fame_pending_field_receipt_guard BEFORE UPDATE ON fame_payment_pending_sync_outbox
  FOR EACH ROW EXECUTE FUNCTION fame_opportunity_field_receipt_guard();
DROP TRIGGER IF EXISTS fame_paid_field_receipt_guard ON fame_payment_paid_sync_outbox;
CREATE TRIGGER fame_paid_field_receipt_guard BEFORE UPDATE ON fame_payment_paid_sync_outbox
  FOR EACH ROW EXECUTE FUNCTION fame_opportunity_field_receipt_guard();

ALTER TABLE fame_agreement_stage_outbox DROP CONSTRAINT IF EXISTS fame_agreement_field_delivery_proof;
ALTER TABLE fame_agreement_stage_outbox ADD CONSTRAINT fame_agreement_field_delivery_proof CHECK
  (status <> 'delivered' OR fame_valid_opportunity_field_receipt(delivery_receipt,payload->>'locationId',payload->>'contactId',payload->>'opportunityId',ARRAY['Signed']));
ALTER TABLE fame_payment_pending_sync_outbox DROP CONSTRAINT IF EXISTS fame_pending_field_delivery_proof;
ALTER TABLE fame_payment_pending_sync_outbox ADD CONSTRAINT fame_pending_field_delivery_proof CHECK
  (status <> 'delivered' OR fame_valid_opportunity_field_receipt(delivery_receipt,location_id,contact_id,opportunity_id,ARRAY['Signed','Ready for Payment']));
ALTER TABLE fame_payment_paid_sync_outbox DROP CONSTRAINT IF EXISTS fame_paid_field_delivery_proof;
ALTER TABLE fame_payment_paid_sync_outbox ADD CONSTRAINT fame_paid_field_delivery_proof CHECK
  (status <> 'delivered' OR fame_valid_opportunity_field_receipt(delivery_receipt,location_id,contact_id,opportunity_id,ARRAY['Signed','Paid']));

ALTER TABLE fame_payment_email_outbox ADD COLUMN IF NOT EXISTS provider_receipt_status TEXT;
ALTER TABLE fame_payment_email_outbox ADD COLUMN IF NOT EXISTS provider_receipt_verified_at TIMESTAMPTZ;
ALTER TABLE fame_payment_email_outbox ADD COLUMN IF NOT EXISTS payment_sent_sync_status TEXT CHECK (payment_sent_sync_status IN ('pending','delivered','skipped_paid','failed'));
ALTER TABLE fame_payment_email_outbox ADD COLUMN IF NOT EXISTS payment_sent_sync_attempts INTEGER NOT NULL DEFAULT 0 CHECK (payment_sent_sync_attempts BETWEEN 0 AND 5);
ALTER TABLE fame_payment_email_outbox ADD COLUMN IF NOT EXISTS payment_sent_sync_error TEXT;
ALTER TABLE fame_payment_email_outbox ADD COLUMN IF NOT EXISTS payment_sent_delivery_receipt JSONB;

COMMIT;
