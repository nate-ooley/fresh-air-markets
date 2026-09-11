# Square production runtime (disabled until configured and deployed)

The backend now supports two explicit runtime pairs. This is implementation readiness, not evidence that live payments are enabled or accepted.

| Vercel environment | Square environment | Live toggle | Behavior |
| --- | --- | --- | --- |
| Preview | sandbox | `false` | Sandbox checkout, signed receipts and expiry |
| Production | production | `true` | Production paths, only with all remaining settings below |
| Any other combination | Any | Any | Reject before provider or database mutations |

Production also requires a server-only access token, location ID, pinned `SQUARE_MERCHANT_ID`, webhook signature key, and:

- `FAME_VENDOR_PORTAL_ORIGIN` set to the exact HTTPS origin that serves this app in Production: `https://freshairmarketsandevents.com`, a subdomain of it, or the Vercel deployment host (for example `https://farmers-market-wine.vercel.app`). No path, port or query.
- `SQUARE_WEBHOOK_URL` equal to that origin plus `/api/payments/square/webhook`. The GitHub scheduler reads the same origin from the repository variable `FAME_VENDOR_PORTAL_ORIGIN`.
- `FAME_MARKET_ACCOUNT_ID` set to the private Fresh Air market account, never the public demo account.
- Every `SQUARE_QA_*` variable absent. Local QA signer/fault controls cannot operate in Production.

The production marketing domain must route `/vendor/*`, vendor API paths, and the Square webhook endpoint to this backend. Credentials, form controls and query parameters never choose the amount, merchant, location, environment, return URL or reservation revision. Server configuration fixes the return to `/vendor/payment?returned=1`. Returning from Square is not evidence of payment; only exact signed webhook reconciliation can mark the persisted reservation paid.

Checkout and link-retirement verify the token's active merchant and active matching location using read-only provider requests before doing work. Production checkout refuses manager accounts other than the configured private Fresh Air account. The webhook requires the pinned merchant/location and matches environment, order, amount, currency and payment identity against the durable ledger. Receipts with different configured identity are recorded for review without modifying the order or reservation.

Migration `016-square-production-environment-fences.sql` permits Production records but does not enable live processing. It preserves Sandbox data, freezes order environment/identity/amount/idempotency, and adds environment foreign keys from webhook receipts and retirement work to their parent order. Expiry and retirement queries fence the configured environment; switching to Production cannot process Sandbox holds. Existing reservation revisions cannot be replayed into a different provider environment.

Before launch: verify database migration, private account, complete vendor invitation/reservation/payment UI, domain routing, all native HighLevel workflow and email acceptance, and Square Sandbox end-to-end acceptance. Then the owner can enter production credentials and enable the explicit production toggle. No live settings, provider calls or charges were changed during implementation.

Official provider references: [environment-specific credentials](https://developer.squareup.com/docs/build-basics/access-tokens), [create payment link and response URL](https://developer.squareup.com/reference/square/checkout/create-payment-link), [Sandbox link example](https://developer.squareup.com/docs/checkout-api/manage-checkout), [link cancellation proof](https://developer.squareup.com/reference/square/checkout-api/DeletePaymentLink).

## Keeping the Square webhook URL in sync

Square delivers payment events only to the `notification_url` stored on its
webhook subscription, and the checkout route refuses to run unless
`SQUARE_WEBHOOK_URL` equals `/api/payments/square/webhook` on
`FAME_VENDOR_PORTAL_ORIGIN`. After changing the portal origin, a signed-in
production manager can compare and fix Square's side without the Developer
console:

- `GET /api/admin/square/webhook` reports the subscription Square holds for the
  portal path and whether it matches `SQUARE_WEBHOOK_URL`.
- `POST /api/admin/square/webhook` (same origin) rewrites that subscription's
  URL to `SQUARE_WEBHOOK_URL`. It never creates, deletes or re-keys
  subscriptions; the signature key is unchanged.
