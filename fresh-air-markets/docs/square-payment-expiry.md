# Square payment expiry and hosted-link retirement

This is the L18 recovery path for the confirmed 48-hour payment window. It
starts only after a usable hosted link was persisted, using Square's
`payment_link.created_at` as the immutable clock anchor.

## Deployment order

1. Apply the portal migration chain through `010`, then apply
   `011-square-payment-checkout-ledger.sql`, `012-square-webhook-events.sql`,
   `013-final-reservation-writer.sql`, `014-square-payment-expiry.sql`, and
   `015-square-payment-expiry-retry-schedule.sql` to the same QA database, in
   that order.
2. Deploy the matching Preview revision with its private QA-only
   `DATABASE_URL`, `AUTH_SECRET`, `FAME_MARKET_ACCOUNT_ID`,
   `FAME_SEASON_ID`, `FAME_BOOTH_CAPACITY`, `CRON_SECRET`, Sandbox access
   token, Sandbox location ID, and exact `SQUARE_ALLOW_LIVE_PAYMENTS=false`.
   `FAME_MARKET_ACCOUNT_ID` is the portal account ID for this QA market, not a
   HighLevel location ID. Enable Vercel system variables so the route receives
   `VERCEL=1` and `VERCEL_ENV=preview`; it refuses to claim a hold without that
   Preview/Sandbox gate.
3. Verify the Sandbox token/location first with `npm run square:verify-sandbox`.
4. In QA, call the endpoint below manually only against the QA Preview and a
   labeled QA reservation. A trusted scheduler can be reviewed separately after
   QA; this runbook does not configure one.

`CRON_SECRET` must be a private, random value of at least 32 characters.
`FAME_MARKET_ACCOUNT_ID` must name the one portal market that this worker may
scan. The endpoint accepts only `Authorization: Bearer <CRON_SECRET>` after
Vercel has admitted the protected Preview request, and returns aggregate
counts; it never returns vendor or payment data.

```
GET https://<stable-qa-preview>/api/internal/cron/square-payment-expiry?x-vercel-protection-bypass=<private-qa-bypass>
Authorization: Bearer <CRON_SECRET>
```

The query capability gets through Vercel Deployment Protection; the bearer
credential authenticates the application route. Both are required for a
protected Preview and neither belongs in a shell history, issue, recording,
browser address bar capture, or test output. A Vercel automation-bypass secret
can bypass protection across protected deployments in its project; it is not a
route-scoped permission. Use a dedicated QA-only project/Preview capability,
never a Production bypass, then rotate or revoke it after QA. Do not configure
a production scheduler as part of this runbook.

Run it frequently enough for the desired operational precision (for example,
every five minutes once a supported trusted scheduler is available). QA uses a
manual, protected Preview invocation against one labeled QA record. Do not
invent a Vercel schedule or expose this endpoint publicly. The payment rule is
still an exact UTC deadline: a job that runs later expires the due hold then;
it never extends the deadline.

## Atomic behavior

For each due `checkout_created` payment order paired with a
`payment_pending` reservation, one transaction:

1. locks the payment order and reservation;
2. checks that their persisted due timestamps match and are due;
3. changes only the payment order to the fenced, non-payable
   `expiry_pending` state;
4. preserves the reservation as `payment_pending` and keeps its immutable
   allocation in capacity accounting; and
5. creates one durable hosted-link retirement item.

The provider delete happens only after that transaction commits. The worker
leases a retirement item, verifies the configured Sandbox merchant/location
against the saved order identity, then calls Square's
[DeletePaymentLink](https://developer.squareup.com/reference/square/checkout-api/DeletePaymentLink)
endpoint. A successful delete can release capacity only when its JSON response
has both the saved link ID and a `cancelled_order_id` equal to the saved Square
order ID. That proof atomically changes both payment order and reservation to
`expired`, records the exact cancelled order on the retirement item, and
releases capacity. A `404` is not proof on its own: the worker retrieves the
exact saved Square order and may recover only if its ID and location match and
its state is explicitly `CANCELED`. Missing, malformed, mismatched, `OPEN`, or
`COMPLETED` provider state becomes `manual_review`; a transport/429/5xx failure
returns the item to `pending` with a durable exponential next-attempt time. It
cannot be reclaimed by another loop iteration in the same scheduler invocation.
In every unresolved case, the order remains `expiry_pending`, the reservation
remains `payment_pending`, and capacity stays held.

Migrations `014` and `015` never invent cancellation proof for an earlier draft
retirement. Migration `015` also quarantines a proofless legacy `retired` row
and any active linked order/reservation into `manual_review` while keeping
capacity held. An operator must reconcile the exact Square order before deciding
any release.

No email, SMS, HighLevel update, refund, payment creation, or browser redirect
is sent or trusted by this worker. A future notification integration must use a
separate reviewed outbox; it must not be added to this scheduler implicitly.

## Payment/expiry race

Webhook completion and expiry lock the same payment-order/reservation pair.
If an on-time signed completion commits first, expiry finds no payable hold. If
the expiry claim commits first, a signed payment event becomes durable
manual-review evidence and fences the payment order, reservation, and any
pending or leased retirement item to `manual_review`; capacity remains held
for an operator. If retirement already finalized before the event locks the
pair, the event remains review evidence and never reclaims inventory.

## QA evidence

Record the QA case ID, Preview revision, UTC timestamps, aggregate endpoint
result, redacted Square Dashboard confirmation of the matching cancelled order,
and the payment/reservation/retirement states before and after deletion. For a
retry, show `expiry_pending` + `payment_pending` + `pending` with a future
`next_attempt_at` and capacity still held. Do not record credentials, full
payment payloads, card values, personal contact data, the Vercel bypass, or
`CRON_SECRET`.

For negative expiry cases, arm exactly one Preview-only
`SQUARE_QA_FAULT_MODE` together with exactly one
`SQUARE_QA_FAULT_PAYMENT_ORDER_ID`; do not set a reservation or event target at
the same time. The available synthetic modes are `expiry_429`, `expiry_500`,
`expiry_timeout`, `expiry_link_mismatch`, `expiry_cancelled_order_mismatch`,
`expiry_cancelled_order_missing`, `expiry_missing_link_open`, and
`expiry_missing_link_completed`. They replace only the provider transport for
that claimed payment order and make no Square API call. Remove the controls and
redeploy before the next case. The local tests cover the timing boundary,
concurrency, retry schedule, provider delete retry, identity fence, legacy
upgrade quarantine, and completion race. A real Sandbox run remains required
before L18 is green.
