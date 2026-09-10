# Square paid status to HighLevel

Migration `018-payment-paid-sync-outbox.sql` records a job only when the committed payment order and reservation are paid and an exact signed-webhook receipt records a matching `COMPLETED` Square payment. It snapshots the application, market, season, contact, opportunity, reservation revision, and Square merchant/location/order/payment/event identities. A deferred trigger observes the webhook transaction after all three records are updated. Webhook rollback removes the queue entry too.

The queue creates no email, SMS, contact, opportunity, reservation, or provider payment. The scheduled worker changes only Vendor Payment Status to Paid on the exact existing Approved/Open HighLevel opportunity, after verifying current contact, opportunity, Signed agreement status and configured field metadata. It rereads the opportunity after the update before recording success. A retry that verifies the Paid field records delivery without another field update. This is provider state confirmation, not proof that a native workflow or email has completed.

## Configuration (disabled by default)

`GET /api/internal/cron/payment-paid-sync` requires `Authorization: Bearer <CRON_SECRET>`. The secret must contain at least 32 characters. The worker returns counts only. It does nothing while `GHL_PAYMENT_SYNC_ENABLED` is unset or not exactly `true`.

Secrets:

- `CRON_SECRET`
- `DATABASE_URL`
- `GHL_API_TOKEN` (scoped to contacts read, opportunities read/write and locations/customFields.readonly for the correct subaccount)

Config shared by both environments:

- `GHL_PAYMENT_SYNC_ENABLED=true` only after the exact IDs and notification routing are verified.
- `GHL_LOCATION_ID=aooAnUXF0COePorBo7wL` (the Fresh Air subaccount).
- `FAME_MARKET_ACCOUNT_ID` — the private Fresh Air market account, never `demo-market`.
- `FAME_SEASON_ID` — exact application season.
- `GHL_APPLICATION_APPROVED_STAGE_ID` — Approved in the selected application pipeline.
- `GHL_AGREEMENT_STATUS_FIELD_ID` — exact Opportunity Vendor Agreement Status field ID.
- `GHL_PAYMENT_STATUS_FIELD_ID` — exact Opportunity Vendor Payment Status field ID.

Preview additionally requires:

- Actual Vercel Preview (`VERCEL=1`, `VERCEL_ENV=preview`).
- `SQUARE_ENVIRONMENT=sandbox`, `SQUARE_ALLOW_LIVE_PAYMENTS=false`.
- `GHL_PAYMENT_DELIVERY_MODE=qa`.
- `GHL_QA_APPLICATION_PIPELINE_ID`, distinct from `GHL_APPLICATION_PIPELINE_ID`.
- `GHL_PAYMENT_QA_ROUTING_VERIFIED=true` only after inspecting every native workflow triggered by agreement or payment custom-field changes and proving that no live contact or admin can be notified and no SMS can run.
- The current contact primary email must be exactly `lnooley@gmail.com` or `nate@autocraftstudios.com`. Queued email snapshots and plus-address variants do not authorize QA delivery.

Production additionally requires:

- Actual Vercel Production (`VERCEL=1`, `VERCEL_ENV=production`).
- `SQUARE_ENVIRONMENT=production`, `SQUARE_ALLOW_LIVE_PAYMENTS=true`.
- `GHL_PAYMENT_DELIVERY_MODE=production` and `GHL_APPLICATION_PIPELINE_ID`.
- No populated `SQUARE_QA_*`, `GHL_QA_*`, or `GHL_PAYMENT_QA_*` settings.

No live IDs, tokens, or routing-verification flag have been invented or enabled by this implementation. Production release remains a separate acceptance step.

## Recovery and limits

The cron route repairs and attempts only one scoped job per call, within its 60-second execution budget. The standalone worker supports up to five jobs when invoked outside this route. Jobs are claimed individually with a 60-second lease and `FOR UPDATE SKIP LOCKED`. A provider request times out after five seconds; provider identity, metadata and final state checks each use bounded requests. Only the lease owner can write a delivery receipt. Retryable failures use bounded backoff and stop in manual review after eight attempts. Identity, field metadata/value, stage, pipeline, closed-opportunity, and QA-recipient failures go directly to manual review. Raw provider bodies and arbitrary exception strings are never stored or returned.

Migrations 020–021 add checkout readiness and verified custom-field receipts. Ready and Paid both require the exact finalized agreement's Signed field receipt; queued agreement work defers without spending the ordinary failure budget. The shared reservation advisory lock also orders the email's Payment Sent update. A fast exact paid event can set Paid before email completion; late Ready/Sent work cannot regress it. Legacy stage-only receipts are fenced and revalidated after migration with old workers paused.

HighLevel's documented update endpoint does not provide compare-and-swap against prior field values. The worker performs exact preflight and final reads and refuses already-diverged/closed opportunities, but it cannot guarantee exclusion of a human editing the same opportunity between those requests. This is a remaining provider API limitation, not an exactly-once native-workflow claim.

## Acceptance evidence still needed

1. Apply migrations through 021 to the correct private Preview database and verify queue triggers remain enabled.
2. Verify the dedicated QA pipeline's full downstream routing, then configure its Approved stage, exact custom-field IDs and QA flag.
3. Complete a real Square Sandbox payment through the private vendor URL and confirm one paid order, reservation, and queue job.
4. Invoke the authenticated worker and confirm the exact QA opportunity's Paid field plus downstream test-email receipts.
5. Replay the webhook/worker, run failure/lease/identity scenarios, and prove no duplicate field trigger or live notification.

Automated suites cover these storage/adapter contracts using disposable PostgreSQL and mocked HighLevel; they do not prove live provider or inbox acceptance.

Official provider contracts: [Get contact](https://marketplace.gohighlevel.com/docs/ghl/contacts/get-contact/), [Get opportunity](https://marketplace.gohighlevel.com/docs/ghl/opportunities/get-opportunity/), [Update opportunity](https://marketplace.gohighlevel.com/docs/ghl/opportunities/update-opportunity/). Requests use `Version: v3` and fixed `services.leadconnectorhq.com` URLs without redirects.
