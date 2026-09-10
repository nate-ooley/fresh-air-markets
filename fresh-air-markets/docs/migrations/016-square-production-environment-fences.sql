-- Enable durable production records without enabling any live provider setting.
-- Deployed routes still require the production runtime gate and pinned identity.
-- Never rewrite an existing Sandbox order into a Production order.
BEGIN;

ALTER TABLE fame_payment_orders
  DROP CONSTRAINT IF EXISTS fame_payment_orders_square_environment_check;
ALTER TABLE fame_payment_orders
  ADD CONSTRAINT fame_payment_orders_square_environment_check
  CHECK (square_environment IN ('sandbox', 'production'));
ALTER TABLE fame_square_payment_link_retirements
  DROP CONSTRAINT IF EXISTS fame_square_payment_link_retirements_square_environment_check;
ALTER TABLE fame_square_payment_link_retirements
  ADD CONSTRAINT fame_square_payment_link_retirements_square_environment_check
  CHECK (square_environment IN ('sandbox', 'production'));

CREATE UNIQUE INDEX IF NOT EXISTS fame_payment_orders_id_environment_idx
  ON fame_payment_orders(id, square_environment);

ALTER TABLE fame_square_webhook_events
  DROP CONSTRAINT IF EXISTS fame_square_webhook_events_order_environment_fk;
ALTER TABLE fame_square_webhook_events
  ADD CONSTRAINT fame_square_webhook_events_order_environment_fk
  FOREIGN KEY (payment_order_id, square_environment)
  REFERENCES fame_payment_orders(id, square_environment);

ALTER TABLE fame_square_payment_link_retirements
  DROP CONSTRAINT IF EXISTS fame_square_retirements_order_environment_fk;
ALTER TABLE fame_square_payment_link_retirements
  ADD CONSTRAINT fame_square_retirements_order_environment_fk
  FOREIGN KEY (payment_order_id, square_environment)
  REFERENCES fame_payment_orders(id, square_environment);

CREATE OR REPLACE FUNCTION fame_guard_square_order_identity() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW.market_id, NEW.reservation_id, NEW.reservation_revision,
         NEW.square_environment, NEW.square_merchant_id, NEW.square_location_id,
         NEW.expected_currency, NEW.expected_total_cents, NEW.idempotency_key)
     IS DISTINCT FROM
     ROW(OLD.market_id, OLD.reservation_id, OLD.reservation_revision,
         OLD.square_environment, OLD.square_merchant_id, OLD.square_location_id,
         OLD.expected_currency, OLD.expected_total_cents, OLD.idempotency_key)
  THEN
    RAISE EXCEPTION 'Square order identity and amount are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS fame_square_order_identity_guard ON fame_payment_orders;
CREATE TRIGGER fame_square_order_identity_guard
  BEFORE UPDATE ON fame_payment_orders
  FOR EACH ROW EXECUTE FUNCTION fame_guard_square_order_identity();

COMMIT;
