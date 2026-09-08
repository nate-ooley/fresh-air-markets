# Square Sandbox checkout ledger

This is the L18 server-side payment boundary. It creates a hosted **Sandbox**
checkout only for a final reservation already committed by CHECK/RESERVE.
It does not create a reservation, send an email, reserve inventory, or mark a
payment successful from a browser return.

## Apply and deploy order

1. Apply the existing portal migration chain through `010`. Migration `006`
   within that chain supplies the composite `(id, market_id)` application key
   required by `011`.
2. Apply `011-square-payment-checkout-ledger.sql` to the QA portal database.
3. Apply `012-square-webhook-events.sql` before enabling a Sandbox checkout.
4. Apply `013-final-reservation-writer.sql`; it is the only writer that creates
   a checkout-eligible reservation and requires `FAME_BOOTH_CAPACITY`.
5. Apply `014-square-payment-expiry.sql`, then
   `015-square-payment-expiry-retry-schedule.sql`, which atomically expires
   unpaid holds and queues idempotent hosted-link retirement with durable retry
   scheduling. This completes the canonical `010`, then `011`–`015` sequence.
6. Deploy the matching Preview revision with private QA-only Square variables,
   `FAME_MARKET_ACCOUNT_ID`, `FAME_SEASON_ID`, `FAME_BOOTH_CAPACITY`, and
   `CRON_SECRET` for the protected expiry endpoint. `FAME_MARKET_ACCOUNT_ID`
   is a portal account ID, not a HighLevel location ID.
7. Run the read-only Sandbox identity verification in
   [square-sandbox-setup.md](./square-sandbox-setup.md).
8. Create the exact Sandbox webhook subscription only after the deployed
   `/api/payments/square/webhook` URL is known.

`011` adds two durable records, while `013` adds the immutable finalization
and date-allocation evidence required by checkout:

- `fame_reservations`: the final CHECK/RESERVE transaction writes the exact
  final revision, quote, dates, quantity, amount and state.
- `fame_payment_orders`: one order per `(reservation_id, reservation_revision)`
  stores the verified Sandbox merchant/location identity, expected USD cents,
  stable provider idempotency key, link/order IDs, deadline and payment state.

The application must not call the checkout route until migration `013` and its
final reservation writer are deployed. A direct form payload, a manually seeded
reservation, or a legacy booking cannot substitute a price, vendor, date,
quantity, currency, revision, provider location, or redirect URL.

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

At the exact persisted deadline, the trusted internal scheduler changes the
order to `expiry_pending`, keeps the reservation `payment_pending`, and queues
the Square-hosted link for deletion while its allocation remains held. Only a
Square DELETE response that identifies the saved link and its exact cancelled
Square order can atomically change both records to `expired` and release
capacity. A `404` triggers exact-order recovery and is safe only when that
stored order is explicitly `CANCELED`. Link deletion has its own durable lease,
so a temporary Square outage cannot release capacity under a live link or cause
a second hosted link. A signed
payment event while the claim is pending fences the order, reservation, and
retirement item to manual review. See
[square-payment-expiry.md](./square-payment-expiry.md) for the authenticated
scheduler and recovery behavior.

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

The remaining release evidence is a deployed QA database with the complete
canonical migration chain through `010`, then `011`–`015`; the final
reservation writer; a protected, authenticated Preview expiry invocation;
Preview webhook subscription; and real Sandbox tests for successful, declined,
abandoned, expired and retried payment attempts. The expiry invocation needs
both the private Vercel protection-bypass capability and `CRON_SECRET`; see
[square-payment-expiry.md](./square-payment-expiry.md). The bypass applies
broadly within its QA project, so rotate or revoke it after QA and never use a
Production bypass.

Square's `payment_link.created_at` must be a strict RFC 3339 calendar timestamp
with an explicit timezone and may be no more than five minutes ahead of the
server clock. A malformed, timezone-less, impossible, or implausibly future
value permanently fails the checkout and sends the held reservation to manager
review; it is never retried into a new payment window.
