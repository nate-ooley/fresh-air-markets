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

Apply `docs/migrations/004-application-review-outbox.sql` after migration 001.
It adds a portal-only review state to `fame_applications`, append-only
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
`markApplicationReviewOutboxDelivered` or `retryApplicationReviewOutbox` with
the returned lease token. Expired leases can be reclaimed. A stale worker
cannot mark a newer worker's job delivered. Only an allow-listed short error
code is saved; raw provider responses remain out of the application ledger.

`dispatchApplicationReviewOutbox` takes an injected delivery function for a
scheduled, authenticated integration worker. It intentionally has no built-in
HighLevel token or HTTP call. The eventual worker must use the payload's exact
opportunity ID, apply downstream idempotency, and mark a job delivered only
after the downstream action succeeds.

## Verification scope

The isolated suite covers route authentication, path/session identity binding,
malformed input, stale source handling, and replay behavior. The PostgreSQL
suite defines five disposable-database scenarios: 100 competing approvals,
changed-key conflict/terminal safety, wrong-market/missing-opportunity/stale
stops, corrected re-submission versus a separate season application, and lease
recovery after provider failure. It must run in CI or a disposable local
PostgreSQL database before release.

This does not prove a deployed portal, individual manager identity, HighLevel
pipeline update, email delivery, or browser workflow. Those remain L06 release
tests.
