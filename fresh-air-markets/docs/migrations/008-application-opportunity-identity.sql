-- Additive identity fence for application-bound document delivery.
-- Apply after 001-application-handoff.sql and 006-application-document-ledger.sql.
-- An application may gain its first HighLevel opportunity ID, but once it has
-- one it must not be silently reassigned to another opportunity.
BEGIN;

CREATE OR REPLACE FUNCTION fame_reject_application_opportunity_reassignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.opportunity_id IS NOT NULL
     AND NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id THEN
    RAISE EXCEPTION 'Application opportunity identity cannot be reassigned';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fame_application_opportunity_identity_guard ON fame_applications;
CREATE TRIGGER fame_application_opportunity_identity_guard
  BEFORE UPDATE OF opportunity_id ON fame_applications
  FOR EACH ROW
  EXECUTE FUNCTION fame_reject_application_opportunity_reassignment();

COMMIT;
