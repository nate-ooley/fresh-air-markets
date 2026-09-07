# Square Sandbox checkout ledger

This is the L18 server-side payment boundary. It creates a hosted **Sandbox**
checkout only for a final reservation already committed by CHECK/RESERVE.
It does not create a reservation, send an email, reserve inventory, or mark a
payment successful from a browser return.

## Apply and deploy order

1. Apply the existing portal migrations through
   `006-application-document-ledger.sql` first. Migration `006` supplies the
   composite `(id, market_id)` application key required by `011`.
2. Apply `011-square-payment-checkout-ledger.sql` to the QA portal database.
3. Apply `012-square-webhook-events.sql` before enabling a Sandbox checkout.
4. Deploy the matching Preview revision with its private Square variables.
5. Run the read-only Sandbox identity verification in
   [square-sandbox-setup.md](./square-sandbox-setup.md).
6. Create the exact Sandbox webhook subscription only after the deployed
   `/api/payments/square/webhook` URL is known.

`011` adds two durable records:

- `fame_reservations`: a future CHECK/RESERVE transaction writes the exact
  final revision, quote, dates, quantity, amount and state.
- `fame_payment_orders`: one order per `(reservation_id, reservation_revision)`
  stores the verified Sandbox merchant/location identity, expected USD cents,
  stable provider idempotency key, link/order IDs, deadline and payment state.

The application must not call the checkout route until its final reservation
writer is deployed. A direct form payload cannot substitute a price, vendor,
date, quantity, currency, revision, provider location, or redirect URL.

## Manager route

`POST /api/admin/reservations/:id/checkout` requires a signed-in manager and a
database-backed, market-scoped reservation. Its request body is ignored. The
route first performs the two read-only Sandbox identity checks, then locks the
reservation and claims one short-lived checkout lease before calling Square.

The first successful hosted-link result records `checkout_created` and the
provider's creation timestamp. Its 48-hour deadline is calculated from that
timestamp and written atomically with the usable link, so pre-link retries do
not shorten the vendor's payment window and later retries cannot extend it. A
repeated manager action returns that same link. If recovery discovers that an
idempotently returned link has already expired before local persistence, it
routes the reservation to manual review instead of reopening it or issuing a
second link. A transient provider failure releases the lease for a retry with
the same provider idempotency key. A permanent provider failure moves the
reservation to manual review rather than freeing or silently recreating
inventory.

Only `payment_pending` reservations and `checkout_created` payment orders may
be marked paid. The webhook ledger validates the exact Sandbox merchant,
location, Square order ID, USD amount, payment state and provider timestamp;
it records rejected, duplicate and out-of-order events for review.

## Verified code scenarios

The automated suite covers committed cents/location persistence, existing-link
reuse, a stable-key retry after a provider outage, a permanent provider error,
nonprofit/expired/cancelled/in-progress stop paths, configuration failures,
manager authentication, and request-body substitution attempts. These are
isolated tests; they do not create a Square payment or contact a vendor.

The remaining release evidence is a deployed QA database, final reservation
writer, Preview webhook subscription, and real Sandbox tests for successful,
declined, abandoned and retried payment attempts.
