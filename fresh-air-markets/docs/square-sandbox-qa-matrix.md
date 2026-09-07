# Square Sandbox QA matrix: L17–L19

This is the release checklist for the Square Sandbox work. It covers only the
QA Preview deployment and Square's Sandbox environment. It is not permission
to create a Production Square application, payment, webhook, email, SMS, or
HighLevel action.

**Current state:** all cases are blocked until the QA database, Preview
deployment, and final reservation writer are connected. The isolated code and
database-contract tests are useful evidence, but they are not the green
end-to-end result below.

## Safety and test-data rules

- Use `lnooley@gmail.com` for the QA vendor record and
  `nate@autocraftstudios.com` for the QA manager/session record. Do not use a
  live vendor, administrator, contact, or distribution list.
- Name every record `QA-SQ-<case>-<timestamp>`. Create no payment follow-up,
  email, SMS, CRM message, or automation from these records. The current
  checkout and webhook routes do not send any themselves.
- Stay in `SQUARE_ENVIRONMENT=sandbox` with
  `SQUARE_ALLOW_LIVE_PAYMENTS=false`, scoped to the QA Preview deployment.
  Never put Square tokens, signature keys, card numbers, or webhook payloads
  in this document, Asana, Linear, a browser recording, or chat.
- When a hosted link needs a payment result, use Square's current documented
  **Sandbox card-not-present success or decline value** on the Sandbox hosted
  page. Copy the value at execution time from Square's
  [Sandbox Payments guide](https://developer.squareup.com/docs/devtools/sandbox/payments).
  Sandbox values cannot charge a real card.
- Attach only a case ID, time, deployment revision, HTTP result, redacted
  Square Dashboard result, and the listed database state to the work item.
  A browser return page is never proof of payment.

## Gates before beginning

| Gate | Required proof | Blocks |
| --- | --- | --- |
| Isolated Preview | A stable HTTPS QA Preview deployment, separate from Production, with the two approved QA identities only. | All cases |
| Sandbox identity | Preview-only `SQUARE_ACCESS_TOKEN` and `SQUARE_LOCATION_ID`; `SQUARE_ENVIRONMENT=sandbox`; `SQUARE_ALLOW_LIVE_PAYMENTS=false`. | L17–L19 |
| Portal access | The same Preview has a QA-only `DATABASE_URL`, private `AUTH_SECRET`, and a signed-in QA manager account for the same market. | L18–L19 |
| Database | Baseline account/application schema, including prerequisite `006-application-document-ledger.sql`, then `011-square-payment-checkout-ledger.sql`, then `012-square-webhook-events.sql`, applied to the QA database. | L18–L19 |
| Reservation source | The final CHECK/RESERVE writer creates an immutable QA `fame_reservations` row. Do not seed a row directly and call that an end-to-end pass. | L18–L19 |
| Webhook subscription | After L18 has a stable Preview URL, set the exact `SQUARE_WEBHOOK_URL` ending in `/api/payments/square/webhook`, create a **Sandbox-only** subscription for `payment.created` and `payment.updated`, then store its Preview-only `SQUARE_WEBHOOK_SIGNATURE_KEY`. | L19 |
| Negative-path harness | A QA-only adapter fault/replay mechanism that can simulate provider `429`/`5xx`/timeout and a database transaction rollback without changing shared Preview credentials or Production code. | L18-04, L18-05, L19-02–L19-05 |

`SQUARE_MERCHANT_ID` is optional. The read-only verifier obtains the actual
Sandbox merchant ID from Square. If it is later stored as an optional guard,
it must exactly match that verified ID.

## L17 — Sandbox identity and configuration (five cases)

Run the verifier through the Preview environment, as described in
[square-sandbox-setup.md](./square-sandbox-setup.md). It makes only
`GET /v2/merchants/me` and `GET /v2/locations/{locationId}`; it must create no
Square order, payment link, webhook, database record, or message.

| Case | Action | Expected green evidence | Pressure / edge condition |
| --- | --- | --- | --- |
| L17-01 | Run `npm run square:verify-sandbox` with the configured Preview values. | Exit `0`; the verified merchant and configured active location match; no `fame_payment_orders` or Square payment-link activity. | Correct token-to-merchant-to-location mapping, not a location name match. |
| L17-02 | In an isolated Preview configuration, omit the token, then separately omit the location ID. | Each invocation fails closed with the generic setup error; no checkout or database write. | Missing-secret handling must not reveal the missing value or fall back to Production. |
| L17-03 | Use a disposable invalid, inactive, or other-test-account location ID with a valid QA Sandbox token. | Verification fails; no payment order/link is created. | Confirms that a valid token cannot authorize a foreign or inactive location. |
| L17-04 | Set a deliberately different optional `SQUARE_MERCHANT_ID` in an isolated Preview configuration. | Verification fails before checkout; the verified merchant is not silently substituted. | Tests the operator-entered merchant mismatch guard. |
| L17-05 | Start five concurrent verifier runs with the valid QA configuration. | All five report the same verified merchant/location pair or fail uniformly due to a documented provider limit; no writes, payments, webhooks, or messages occur. | Read-only pressure test; record provider rate limiting as a red result, never retry with Production values. |

## L18 — Hosted checkout and durable reservation mapping (five cases)

The route is `POST /api/admin/reservations/:id/checkout`. It requires a signed
in manager and derives the market, reservation, amount, currency, dates,
quantity, vendor identity, and redirect behavior from the committed
reservation. It must never accept those values from the request body.

| Case | Action | Expected green evidence | Pressure / edge condition |
| --- | --- | --- | --- |
| L18-01 | Create one fresh final QA reservation for `lnooley@gmail.com`, then request checkout as the QA manager. Do not distribute the returned link. | `201`; exactly one `fame_payment_orders` row with `sandbox`, verified merchant/location, stored USD cents and reservation revision; `checkout_created`; Square Sandbox shows one matching payment link/order; the due time is exactly 48 hours after Square's `payment_link.created_at`. Reservation is `payment_pending`, never `paid`. | Correct server-side mapping; no browser body value controls money, capacity, or vendor. |
| L18-02 | Send five concurrent checkout requests for the same reservation. | After they settle: one payment-order row, one Square link/order, one stable idempotency key, and one immutable due time. Responses may be one `201`, `202` while leased, or `200` once the existing link is available; no distinct second link/order. | Replay/concurrency fence. |
| L18-03 | Send a checkout request with attacker-controlled price, vendor email, dates, booth quantity, reservation ID, and redirect URL in the body; repeat from a QA manager in another market. | The first result uses only the path reservation and its committed database values. The other-market request returns `404` and creates no order. | Tests body substitution and market isolation. |
| L18-04 | Use the QA-only provider-fault harness to return `429`, `5xx`, and a timeout before a usable link is persisted; then restore the adapter and retry the same reservation. | Failure is safe (`503`/retry state); the lease is released, the idempotency key stays unchanged, and no due time is stored before a link exists. The later success creates one link and anchors the due time once, from Square's creation time. | No deliberate bad token or Production credential is used to manufacture the failure. |
| L18-05 | Exercise the QA-only permanent provider error and a provider response whose link is already expired before local persistence; then use separate final reservations in nonprofit, expired, cancelled, declined, manual-review, and already-processing states. | Permanent or already-expired-link failure produces `failed` plus reservation `manual_review`, with no invented/replaced link. Each nonpayable/terminal fixture produces `409` or `202` as applicable and makes no Square provider call or link. | Verifies capacity is held/reviewed rather than silently freed, and that a normal checkout route never reports `paid`. |

## L19 — Signed webhook receipt and reconciliation (five cases)

The route is `POST /api/payments/square/webhook`. It reads raw bytes, verifies
`x-square-hmacsha256-signature` against the exact configured public HTTPS URL,
then parses and persists the event. A payment can become paid only when its
persisted Sandbox merchant, location, Square order, USD cents, status,
deadline, and reservation/order states all match.

| Case | Action | Expected green evidence | Pressure / edge condition |
| --- | --- | --- | --- |
| L19-01 | Complete the L18 Sandbox hosted link with Square's documented Sandbox success test value and let Square deliver its signed events. | A matching `COMPLETED` event returns `200` with `paid`; one durable receipt has `disposition=paid`; the exact payment order and reservation become `paid`; Square Sandbox Dashboard shows the matching payment. Any prior non-completed event is only `ignored`. No email, SMS, CRM update, or browser return marks it paid. | Covers the provider-to-order mapping rather than a redirect. |
| L19-02 | Replay the exact same signed completed event five times through Square's Sandbox delivery replay or the QA-only signer fixture. | One receipt/state transition is `paid`; the four replays return `200` `duplicate`; exactly one paid reservation and payment order remain. | Exact-id replay pressure test. |
| L19-03 | Deliver: an invalid-HMAC body, a correctly signed malformed/unsupported payment event, and a body over 128 KiB. | They return `401`, `400`, and `413` respectively; no webhook-ledger row or payment/reservation mutation is written. | Raw body must be authenticated before JSON parsing; the handler never exposes the signature key. |
| L19-04 | Deliver signed completed events with wrong merchant, location/order, cents/currency, and a provider time after the stored 48-hour deadline. | Each is `202` `manual_review`, never paid. Identity misses create a durable review receipt with no matched payment order; amount/currency/deadline matches against an existing order place that order and reservation in `manual_review`. | Correct identity/money/deadline fencing, including a deliberately altered event ID reuse if the signer fixture supports it. |
| L19-05 | First deliver a newer `FAILED` event, then a newer valid `COMPLETED` event with a different payment ID; separately deliver an older out-of-order update and force one QA database transaction failure before replaying the exact event. | Failed/non-completed and stale updates return `200` `ignored`; the failed attempt does not bind the final payment ID. The newer valid completion can pay. A transaction failure returns `503` with no receipt or paid mutation; replay then succeeds exactly once. | Ordering, retry, and rollback test without manually altering live data. |

## Green criteria and remaining blocks

L17 is green only when all five L17 cases have evidence from the configured
Preview environment. L18 is green only after L17 plus all five checkout cases
against a real QA database and Square Sandbox. L19 is green only after L18,
all five webhook cases, and a review of every `manual_review` receipt.

The following are still blockers until they exist in the QA Preview
environment:

1. A linked Preview deployment that can receive the private Square variables.
2. A QA database with the baseline schema and migrations
   `006-application-document-ledger.sql`,
   `011-square-payment-checkout-ledger.sql`, then
   `012-square-webhook-events.sql` in that order.
3. The final CHECK/RESERVE writer that produces the immutable reservation used
   by the checkout route.
4. A stable HTTPS Preview URL and the Sandbox-only Square subscription with
   its matching signature key.
5. Controlled QA fault/replay coverage for provider and database failures.

Until those five gates are met, mark every matrix row **Blocked**, not green.
For the current code-level coverage, see
[square-checkout-ledger.md](./square-checkout-ledger.md),
[`011-square-payment-checkout-ledger.sql`](./migrations/011-square-payment-checkout-ledger.sql),
and [`012-square-webhook-events.sql`](./migrations/012-square-webhook-events.sql).
