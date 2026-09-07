# Fresh Air Markets — backend integration requirements
Updated September 7, 2026. This is the implementation contract for AI Studio + GitHub portal + HighLevel + Square.

## Confirmed architecture and existing records
- AI Studio project 1779802876495102326 serves freshairmarketsandevents.com. It owns marketing content and the initial application.
- The initial form is fresh-air-vendor-application. Its built-in tracking integration creates/updates contacts in HighLevel location aooAnUXF0COePorBo7wL.
- Native account audit found 33 contacts, including QA. A real existing application was traced from form-submission activity to Contact Created, populated Vendor Business Name, Vendor Category and preliminary Vendor Dates Requested, and an existing opportunity. This is sample evidence, not a 33-record reconciliation.
- Preserve HighLevel contact IDs and opportunity history. Do not re-import these people as new contacts or replay approvals when connecting the portal.
- GitHub nate-ooley/fresh-air-markets owns the vendor/manager portal and reservation backend. Its existing store selects PostgreSQL when DATABASE_URL exists and uses temporary memory otherwise. The actual deployed database/credentials have not been verified: Vercel connector returned no teams and could not list the observed account’s projects.
- HighLevel owns CRM identity, application/document review and email communications. The database owns market dates, inventory, reservation revisions, payment orders and reconciliation. Square owns payment processing.
- Never use the HighLevel connector's ZEAL data for this project; that connector still returns another account. Native UI confirmed the correct Fresh Air location.

## Confirmed business decisions
- Standard space is 10 × 10; quantity is final booths per market, not the initial estimate.
- Paid vendors: $30/booth/date for Full Season; $35 for a complete set of at least four adjacent entries in the canonical market calendar; otherwise $40.
- Nonprofits are $0 and consume inventory; maximum one nonprofit per date. Maximum four Food Trucks per date.
- Thomas determines Required versus Not Required for food licensing during review.
- Email only. Vendors used in QA: lnooley@gmail.com and nate@autocraftstudios.com. Admin QA goes to laura@autocraftstudios.com. Production Thomas routing is separate.
- Owner confirmed final market is Saturday May 29, 2027. Saved date options start October 3, 2026 and contain every Saturday, with an erroneous May 27 final label. The corrected code configuration has 35 Saturdays ending May 29. No skipped dates were found in the supplied reference.
- Owner confirmed a 48-hour payment window. Proposed implementation starts it when a usable payment request is sent; store a UTC deadline and show local time. Inventory hold/release and late-payment reconciliation still need implementation and verification.
- Existing nonrefundable and manager-exception rules remain. No automatic refund or credit mechanism is introduced.

## Required data and ownership
Persist these entities in the portal database; do not treat a contact multi-select as the inventory ledger:
1. Market/season: stable ID, exact calendar version, dates, timezone, active booth inventory and category limits.
2. Vendor identity: market ID + HighLevel location ID + contact ID; normalized email for matching only. One contact may have multiple season applications.
3. Application: stable submission ID, season ID, contact/opportunity IDs, original submission timestamp and raw requested values, normalized planning fields, review state.
4. Document review: application ID, document kind, file reference, submitted version, manager decision, correction note, decision timestamp. An older completion must not approve a newer document.
5. Reservation: immutable revision, final date rows, booth count/IDs, category, quote version, per-booth rate, total cents, state, hold deadline, manager approval evidence.
6. Payment order: reservation/revision, Square environment + merchant/location/order/link IDs, expected currency/amount, idempotency key, payment ID and status.
7. Integration event/outbox: unique source/event ID, payload hash, processing state, attempt count, next retry and last safe error. Commit domain change + outbound job together.
8. Import ledger: source ID, before/after identifiers, created/matched/skipped/review-needed result; no credentials or unnecessary contact data in reports.

## Existing applicant reconciliation and initial application boundary
Acceptance: every source application is matched to one intended contact and season application, or appears in a review queue with a reason.
- Read the full HighLevel contact/opportunity list and form-event history using credentials scoped to this exact location. Record source counts and pagination.
- Match by existing location/contact ID first, then unique normalized email. Never merge ambiguous matches automatically; phone/name alone must not collapse different people.
- Backfill missing portal application records from HighLevel. Create a HighLevel contact only if a source submission is proven absent.
- Preserve nonempty business fields and approval/document/payment states. An old submission or import may fill an empty field but must not erase a later manager decision.
- Exclude clearly marked QA records from live reservations; retain their audit history.
- Treat old “Full Season (Oct 3 - May 27)” as a legacy preliminary choice. Preserve original text, attach corrected calendar version, and require final-date confirmation. Do not silently rewrite confirmed reservations or bill preliminary dates.
- A repeat submission updates the same application revision while under review. A paid/confirmed application receives a change request, not an overwrite.
- Complete a dry-run reconciliation first, then run the same operation again: second run creates zero duplicates and sends zero duplicate approval emails.

## AI Studio → HighLevel → portal handoff
Keep the current working front-end form capture active. Add a server-to-server integration after successful intake:
- HighLevel sends a signed event containing stable event ID, contact ID, opportunity ID and intended season. The portal verifies source/location, fetches authoritative fields and stores the application idempotently.
- Do not expose HighLevel or Square tokens in AI Studio code, URLs or browser storage.
- Portal login/invitation must bind to the intended vendor/application, expire and resist replay. A raw email query parameter is not authorization.
- Vendor sees agreement/insurance/food requirements and only receives final-date selection after all gates pass.
- The marketing site links to the configured portal domain. Maintain a clear return path and consistent identity/branding; no second unrelated application form.
- Retry failed sync from the outbox. A frontend success screen must not conceal lost backend capture; reconciliation catches historical failures.

## CHECK → manager review → RESERVE
CHECK validates canonical dates, full-season exclusivity, final integer quantity and document/application state. It reads availability and calculates the entire quote; it does not write a browser-supplied amount.
The authenticated manager RESERVE route rereads the approved current source event, signed agreement, current approved insurance, and Thomas’s food-license decision/document before it writes. It requires private `FAME_BOOTH_CAPACITY` because no source requirement defines a market-wide capacity. It locks shared capacity in sorted market/date order, re-quotes all dates, enforces booth, Food Truck and nonprofit limits, and rolls back the entire set if any date is unavailable. It never uses the legacy booking table.
The resulting finalization and allocation evidence is immutable; paid vendors start held for the separate checkout action and nonprofits start confirmed. This route has no outbound message or payment call. Repeated identical manager approval returns the existing reservation; a different selection conflicts. See [final-reservation.md](./final-reservation.md).
Required QA evidence still includes competing final requests, a quantity/date change before reserve, retry after timeout, full rollback, cross-market isolation, migration against a reviewed database, and fresh-connection behavior.

## Square API setup and owner credential entry
Square is the only selected payment provider. The owner signs in to Square Developer Console and privately adds the API settings to the Vercel project connected to this repository.
The initial private Preview settings are `SQUARE_ENVIRONMENT=sandbox`,
`SQUARE_ALLOW_LIVE_PAYMENTS=false`, `SQUARE_ACCESS_TOKEN`, and
`SQUARE_LOCATION_ID`. `SQUARE_MERCHANT_ID` is optional: the setup verifier
retrieves the merchant for the token and treats a nonblank configured value as
an additional mismatch guard. The durable order ledger stores the verified
merchant ID with each order. Set `SQUARE_WEBHOOK_SIGNATURE_KEY` and
`SQUARE_WEBHOOK_URL` only after the deployed webhook route and its subscription
are ready. For the protected QA Preview, keep Vercel Authentication enabled and
use its dedicated automation-bypass query value in the exact stored webhook URL;
Square signs that exact URL, including the query. The staged setup instructions are in
[`square-sandbox-setup.md`](square-sandbox-setup.md).
Square username/password stays in Square. It is not used as an API token.
Prepared adapter: create hosted payment links with a stable reservation/revision idempotency key, integer USD cents, correct location and tipping disabled. It refuses expired, missing or zero-dollar requests. No live Square calls were made.
Prepared webhook verification: compare HMAC signature using exact raw body plus the configured notification URL; match only completed payments for the expected merchant, location, order, amount and currency.
Before exposing a webhook endpoint or enabling checkout, implement the durable payment-order and event ledger above. Verify signature before JSON processing; record and deduplicate event/payment IDs atomically. Never mark Paid from the browser redirect or a delivery receipt. Confirm capacity remains valid before final confirmation.
Do not register a placeholder webhook URL. Use the deployed endpoint only after its persistence/reconciliation handler is implemented.
Provider references:
- https://developer.squareup.com/reference/square/checkout/create-payment-link
- https://developer.squareup.com/docs/webhooks/step3validate
The adapter and contract tests are prepared; checkout endpoints, durable webhook processing, Square account connection and payment-flow deployment remain open.

## 48-hour payment deadline and recovery
- Persist payment_request_sent_at and payment_due_at once; retries do not extend them.
- At the deadline, the authenticated expiry worker transitions an unpaid
  `checkout_created`/`payment_pending` hold once to `expiry_pending` and queues
  durable Sandbox link retirement while the allocation remains held. Only a
  verified DELETE response whose link and `cancelled_order_id` match the saved
  identifiers atomically makes both records `expired` and releases capacity. A
  `404` requires exact saved-order recovery in state `CANCELED`; every missing,
  mismatched, open, completed, or malformed response enters manual review with
  capacity held. Allocation rows remain immutable audit history. A separate
  future notification outbox is required before any email; the current worker
  sends no email, SMS, HighLevel update, or payment action.
- Serialize payment completion with expiration. A signed event received while
  `expiry_pending` fences the payment order, reservation, and retirement item
  to manual review and keeps capacity held. An event after final expiration is
  durable review evidence and never reclaims inventory already given to another
  vendor.
- A provider payment completed before the deadline but delivered late requires provider timestamp/order reconciliation and an inventory-safe resolution.
- Paid and nonprofit-confirmed reservations are not expired by the unpaid-hold job.
- Clock tests cover just before/exactly at/after deadline and daylight-saving
  transitions. The durable scheduler also has PostgreSQL concurrency tests for
  expiry, capacity release, payment replay, and provider-delete retry. Deploy
  migrations `014-square-payment-expiry.sql` and
  `015-square-payment-expiry-retry-schedule.sql`, then follow
  [square-payment-expiry.md](square-payment-expiry.md) before calling L18 green.

## Document and form requirements
- Required food-license path: request → uploaded/submitted → Laura QA or Thomas production review → approve or correction → resubmit with version history. Blank/unknown is blocked.
- Insurance upload permits configured formats only, rejects missing/unsupported/corrupt/oversized files, and never auto-approves an upload.
- Actual agreement signing/completion requires an authorized signer; test-mode send success does not prove signing.
- Replace editable instructions with static content, update all forms/AI Studio date labels to May 29 without dropping legacy choices, preserve required final quantity and Submit-last order, replace placeholder policy links.
- Test approval-link replay, wrong/old opportunity, missing opportunity, waitlist/decline, incomplete documents, duplicate dates, invalid quantities and already-confirmed resubmissions.

## Test evidence and release gate
Current code suite: 51 tests passed; production build passed. Added 36 malformed-body cases across six real route handlers using isolated boundary doubles, missing-admin-auth rejection, rejected/cancelled approval regression, Square adapter/signature/payment-match cases, 48-hour DST cases and corrected calendar pricing.
No new live payment, browser submission, signature, database-concurrency or deployment test is claimed.
The 36-check Asana grid remains the launch gate. Each check is green only within its named scope. Record run timestamp, environment/commit, scenario, expected/actual result and evidence. Reopen regressions.
Asana: https://app.asana.com/1/1213438609341517/project/1216402541720351/task/1218219611209298
Linear: https://linear.app/autocraftstudios/issue/AUT-4591/fresh-air-markets-launch-testing-checklist-36-checks
Draft PR: https://github.com/nate-ooley/fresh-air-markets/pull/1

## Implemented protected application handoff (not deployed)
POST /api/integrations/highlevel/applications now captures an application snapshot into PostgreSQL using stable location/contact/season IDs. It refuses missing database configuration, short/missing shared secret, unauthorized calls, invalid/wrong-location or wrong-season IDs, non-object snapshots and bodies over 128 KiB.
The migration adds fame_applications and append-only fame_application_events. An exact event retry is acknowledged without adding another application. Reusing an event ID with different content returns conflict. Failed persistence returns 503 for retry; no memory fallback and no approval reset.
Configure GHL_APPLICATION_WEBHOOK_SECRET (private random value at least 32 characters), FAME_MARKET_ACCOUNT_ID (existing portal accounts.id), FAME_SEASON_ID=2026-2027, FAME_BOOTH_CAPACITY (the approved whole-number market-wide capacity), GHL_LOCATION_ID and DATABASE_URL.
After applying docs/migrations/001-application-handoff.sql and deploying a verified preview, configure the HighLevel server-side custom webhook action after intake to POST to the deployed route. Authorization header is Bearer followed by the shared secret. Never put that header in AI Studio browser code.
Body contract:
{
  "eventId": "stable-source-event-id",
  "contactId": "existing-highlevel-contact-id",
  "opportunityId": "existing-opportunity-id",
  "locationId": "aooAnUXF0COePorBo7wL",
  "seasonId": "2026-2027",
  "snapshot": {
    "firstName": "source field",
    "lastName": "source field",
    "email": "source field",
    "customFields": "source custom-field data with original field IDs"
  }
}
Opportunity ID is optional for historical contacts without an opportunity. Use a stable import event ID for each source record and preserve the exact body on retry. Backfill sends records to this protected portal endpoint; it does not recreate HighLevel contacts.
Repeated portal approvals now skip duplicate HighLevel lifecycle sync; cancelled/rejected bookings cannot be revived by a late approval. Durable retry of a first failed CRM sync still needs an outbox.
The API trusts the authenticated HighLevel sender for the snapshot. Before adding automated approvals or payments, implement authoritative reconciliation against current CRM records and the existing application/document review state.
Seven handler tests cover authorization, configuration, invalid IDs/location/season, snapshot preservation, duplicate/conflict responses, persistence failure and payload limits. These are handler tests with a persistence double; actual PostgreSQL migration/concurrency and live HighLevel webhook delivery remain open.
