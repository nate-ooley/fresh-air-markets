# Vendor reservation and payment journey

This implementation is staged in the draft PR. Production payments and hosted
acceptance remain unverified until the release checks below are completed.

## Manager path

1. Open the exact application from `/applications` and review it.
2. On the approved application, choose the final applicant category, Thomas's
   food-license decision, dates and booth quantity. Historical May 27 selections
   require explicit confirmation of Saturday May 29.
3. Save the final reservation. The server rechecks approval, signed agreement,
   current approved documents and capacity, then saves an immutable quote.
   Reloading reads that committed reservation without reserving again.
4. Create its Square payment request. Retrying retrieves the same provider order
   and deadline. Nonprofits skip payment. Creating this request does not send email.
   A durable job queues Ready for Payment custom-field sync for the application's same
   HighLevel opportunity. The protected worker waits for the exact Signed agreement-field
   delivery receipt before updating Vendor Payment Status; it never creates another
   opportunity or changes the application's pipeline.
5. Send the private payment email through the explicit manager confirmation.
   Preparation verifies the current contact, email, opportunity, Approved/open state, Signed agreement and Ready for
   Payment status. A durable send record prevents a second submission after an
   uncertain response. Provider acceptance and delivery are shown separately.
   A separately created vendor access link can also be copied deliberately;
   replacing it revokes the previous link and its browser sessions.

## Vendor path

The invitation uses `/vendor/payment#token=...`. Its secret is removed from the
address bar before any request. Opening the page does not consume it: the vendor
clicks **Open my reservation**, which exchanges the one-time token for a separate
HttpOnly cookie. Only hashes are stored. The cookie grants access to that exact
reservation and cannot authorize a manager action.

The page shows approved dates, booth quantity, price and the server-recorded
48-hour deadline. Checkout is offered only while the matching reservation and
payment order remain payable, and only to a Square-owned URL for the configured
environment. Sandbox is visibly labeled. Expired, stopped, cancelled or paid
records never show a checkout action. The session lasts up to seven days so a
receipt or expired status remains readable after the deadline.

Square returns to `/vendor/payment?returned=1`. That parameter shows a pending
confirmation message only. A verified webhook must confirm the exact provider
merchant, location, order, amount and reservation before the page says paid.

## Required release work

- Apply and verify migrations 001–021 on the reviewed Preview database, including
  the private Fresh Air account and confirmed overall booth capacity.
- Set `FAME_VENDOR_PORTAL_ORIGIN` as **Config** to the exact Preview HTTPS origin
  used for testing. Production must use `https://freshairmarketsandevents.com`.
- Route vendor payment, staff login/application pages, their APIs, the Square
  webhook, recovery endpoints and required assets to this application under
  the canonical marketing domain. Staff payment actions also enforce that origin. This code
  does not change domain ownership, DNS or the HighLevel-hosted site.
- Privately verify Sandbox merchant/location and webhook credentials, then run
  real Sandbox success, decline, return, replay, expiry and recovery scenarios.
- Complete the correct HighLevel application/document handoff, automated private
  link delivery, paid-state synchronization and the authorized inbox checks.
- Invoke the protected QA workers in application review, agreement completion,
  Ready for Payment, payment email, paid-state sync and expiry order. Creating
  checkout queues readiness-field work; this batch does not dispatch it inline.
  Keep the Production scheduler disabled until hosted acceptance passes.
- Verify Production settings and the website routing; review and authorize the
  final release. Adding production code does not enable live payments.

## Verification boundaries

Unit and PostgreSQL tests cover authentication, one-time token exchange,
rotation, expiry, tenant/revision isolation, immutable quotes, provider environment
separation and webhook reconciliation. Browser interaction, real Sandbox delivery
and production-domain routing require separate evidence. Green code tests must not
be used to mark the full hosted workflow green.
