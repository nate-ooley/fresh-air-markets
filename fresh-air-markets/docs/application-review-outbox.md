# Exact application review and delivery recovery

This is a portal-side foundation for L06. It does not replace the existing
HighLevel workflow or send any email by itself.

## What is bound together

`PATCH /api/admin/applications/:applicationId/review` accepts only a signed-in
portal market session, an internal application UUID in the path, the latest
captured HighLevel source event ID, a UUID v4 `Idempotency-Key`, and one of:

- `approve`
- `request_changes` with a manager reason
- `decline` with a manager reason

The request body cannot select a market, contact, opportunity, email, or a
different application. The database verifies that the application belongs to
the session's market, has a stable opportunity ID, and that the supplied source
event is still the newest captured event for that application. A missing or
stale identity stops before a review state, audit, or outbox row is created.

The current portal session identifies the market account, so the audit records
that account as the actor. A future individual-manager/role system must replace
that actor field with a user ID before this can be treated as a named-person
audit trail.

## Transaction and recovery model

Apply `docs/migrations/004-application-review-outbox.sql` after migration 001,
then `docs/migrations/010-application-review-terminal-state.sql`. It adds a
portal-only review state to `fame_applications`, append-only
`fame_application_review_events`, and `fame_application_outbox`.

One transaction changes the portal review state, records the decision, and
creates one work item containing the exact application, source-event, contact,
opportunity, location, season, and review-event identities. Source capture and
manager review also share a transaction-scoped application-identity lock. That
means a decision either observes an inbound source event or the event begins
after the decision commits; it cannot be inserted halfway through a review.
Repeating the same key and content returns the original decision; reusing its
key with different content conflicts. Terminal approved/declined records cannot
be overwritten. After a correction, another decision requires a newer captured
source event.

Workers use `claimApplicationReviewOutbox`, then either
`markApplicationReviewOutboxDelivered`, `retryApplicationReviewOutbox`, or
`failApplicationReviewOutbox` with the returned unexpired lease token. Expired
leases can be reclaimed. A stale worker cannot mark a newer worker's job
delivered. Permanent identity, stage, status and provider-rejection failures
become inspectable `failed` rows instead of retrying indefinitely; a corrected
mapping must be explicitly requeued. Only an allow-listed short error code is
saved; raw provider responses remain out of the application ledger.

`dispatchApplicationReviewOutbox` takes an injected delivery function for a
scheduled, authenticated integration worker. The included L06 adapter uses
HighLevel's v3 opportunity endpoint and, in Preview, the exact contact endpoint.
It never searches for or upserts a contact or chooses a newest record. It needs
these private deployment variables:

- `GHL_API_TOKEN` (Secret), with `contacts.readonly`, `opportunities.readonly`
  and `opportunities.write` for the Fresh Air sub-account;
- `GHL_LOCATION_ID=aooAnUXF0COePorBo7wL` (Config);
- `GHL_APPLICATION_PIPELINE_ID` (Config), always the actual Production pipeline
  ID, including in Preview where it is used to prove separation;
- `GHL_QA_APPLICATION_PIPELINE_ID` (Config, Preview only), the separate QA
  pipeline ID. Review, payment email and paid-status delivery all select this
  same pipeline in Preview;
- `GHL_APPLICATION_REVIEW_STAGE_ID`, `GHL_APPLICATION_APPROVED_STAGE_ID`,
  `GHL_APPLICATION_CHANGES_REQUESTED_STAGE_ID`, and
  `GHL_APPLICATION_DECLINED_STAGE_ID` (Config): four distinct stage IDs belonging
  to the selected environment's pipeline;
- `GHL_PAYMENT_QA_ROUTING_VERIFIED=true` (Config, Preview only), set only after
  every downstream native workflow triggered by review or payment stages is
  checked to prevent live vendor/admin notifications and SMS;
- `CRON_SECRET`, a 32+ character credential for the recovery endpoint.

The adapter requires an actual Vercel Preview or Production runtime
(`VERCEL=1`, platform-provided `VERCEL_ENV`). Preview never falls back to the
Production pipeline. Production uses `GHL_APPLICATION_PIPELINE_ID` and rejects
nonempty `GHL_QA_*` or `GHL_PAYMENT_QA_*` controls. Review does not depend on
Square payment enablement, because review precedes payment.

The manager review route first commits the review and outbox transaction, then
tries that **same outbox ID** immediately. It checks the payload location
against the configured location before any request, then reads the immutable
opportunity ID, contact ID, pipeline and returned location ID before moving the
record. In Preview it also reads that exact contact's current primary email,
allowing only `lnooley@gmail.com` or `nate@autocraftstudios.com`, and repeats this
check immediately before the stage update. A changed identity or unapproved
email fails with a terminal identity error before any PUT. These checks cannot
replace verification of downstream native admin recipients; that is what the
routing verification flag records. It accepts only the configured Review stage on an open opportunity,
moves it to the stage for the saved decision without changing lifecycle status,
then reads it again to verify the destination and status. If a retry starts
after a successful provider update, finding the target stage is a successful
no-op rather than a second workflow trigger.

HighLevel does not expose an atomic compare-and-swap across the contact read
and opportunity update. An operator changing the contact after the last read
can still race delivery; keep the verified QA pipeline isolated throughout
testing. Requests refuse redirects so credentials cannot follow another origin.

`GET /api/internal/cron/application-review-outbox` is the recovery path. It
requires `Authorization: Bearer <CRON_SECRET>`, returns counts only, and does
not expose vendor details. Each run claims one job with a 60-second lease and a
60-second route duration limit. Preview delivery can make five provider calls
with five-second timeouts; claiming a batch would age later jobs' leases while
the earlier jobs wait on HighLevel. Configure it with an authenticated scheduler only
after confirming the hosting plan supports the intended cadence. The immediate
per-decision attempt does not wait for that scheduler.

## Verification scope

The isolated suite covers route authentication, path/session identity binding,
malformed input, stale source handling, and replay behavior. The PostgreSQL
suite defines five disposable-database scenarios: 100 competing approvals,
changed-key conflict/terminal safety, wrong-market/missing-opportunity/stale
stops, corrected re-submission versus a separate season application, and lease
recovery after provider failure. It must run in CI or a disposable local
PostgreSQL database before release.

This does not prove a deployed portal, individual manager identity, configured
HighLevel pipeline/stage IDs, email delivery, or browser workflow. Those remain
L06 release tests.
