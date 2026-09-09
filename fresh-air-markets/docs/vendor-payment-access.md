# Reservation-specific vendor payment access

The portal uses a vendor session separate from the manager account. It exposes
only the committed reservation's approved dates, quantity, rate, total, payment
deadline and verified payment state. It never grants manager access or includes
application snapshots, contact IDs, documents, names or email addresses.

## Configuration and database

Apply `017-vendor-payment-access.sql` after the final-reservation migration and
the other ordered migrations. The runtime requires persistent PostgreSQL and a
private `FAME_MARKET_ACCOUNT_ID` (the public `demo-market` is refused).

Set `FAME_VENDOR_PORTAL_ORIGIN` to the exact HTTPS site origin without a path:

- Preview: the selected Farmers Market Preview `*.vercel.app` origin, with
  `SQUARE_ENVIRONMENT=sandbox` and `SQUARE_ALLOW_LIVE_PAYMENTS=false`.
- Production: `https://freshairmarketsandevents.com`, with
  `SQUARE_ENVIRONMENT=production`. Checkout links are exposed only when
  `SQUARE_ALLOW_LIVE_PAYMENTS=true`; stopping payments preserves receipt access.

Production refuses leftover `SQUARE_QA_*` controls. This access layer does not
enable payment processing or change credentials. The separate Square runtime,
webhook and approved-domain setup must also be completed and verified.

## Issuance and use

1. A signed-in manager sends same-origin `POST {}` to
   `/api/admin/reservations/{id}/access`. The configured market and immutable
   finalization must match. Paid vendors need an existing, exact Square ledger
   in `checkout_created` with a future 48-hour deadline, or a verified paid
   receipt. A confirmed nonprofit needs no Square order.
2. The response contains `invitationUrl`, `invitationToken` and `expiresAt`.
   The URL uses the configured origin and `/vendor/payment#token=...`.
   Do not log it, put it in analytics, or turn it into a query parameter.
   Nothing sends an email automatically. The manager must use an authorized
   delivery process for the intended vendor.
3. The page explicitly posts `{token}` to `/api/vendor/access`. Merely fetching
   or scanning the link does not consume it. One transaction consumes the
   invitation and exchanges it for an independent random vendor session.
4. `GET /api/vendor/payment` reads the HttpOnly vendor cookie. There are no
   caller-selected reservation or account parameters. The cookie is Secure,
   SameSite=Lax and scoped to `/api/vendor`.
5. `POST /api/vendor/logout` revokes the server session and expires the cookie.

Invitation and session values contain 256 random bits; the database stores only
SHA-256 hashes. A pending invitation expires at the earlier of its stored payment
deadline or 48 hours after issuance. A nonprofit or paid-receipt invitation
expires after seven days. Sessions last seven days so the vendor can still see
expired or paid status after the deadline. The checkout URL is removed at the
deadline, when payments are stopped, or for mismatched/terminal records. Only a
matching paid payment ledger with provider status `COMPLETED` can show paid.
A browser return, request parameter or reservation state alone cannot do so.

Issuing a new invitation revokes every previous invitation and vendor session
for that reservation. Lost one-use links require the manager to issue a new
one. The original quote and 48-hour deadline are never extended by this action.

## Verification scope

The isolated tests cover token secrecy, configuration/origin fencing, bounded
JSON input, manager authentication, cookie separation, safe responses and
logout. The PostgreSQL suite applies the real migration and covers 100 competing
exchanges, concurrent rotation, cross-market and revision rejection, deadlines,
paid receipts, unsafe provider URLs, mismatched amounts/states, nonprofit
confirmation, rollback and revocation. These tests do not prove that migration
017 is installed in the hosted database or that a vendor received an email.
Hosted acceptance still requires issuance, delivery to an authorized test
recipient, browser exchange, Sandbox checkout, signed webhook reconciliation,
and a receipt viewed on the configured site.
