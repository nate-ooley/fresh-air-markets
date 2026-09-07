# Vendor scenario tests

Run `npm test` with Node 22. Tests compile the existing store and session modules into `.test-build`, then run directly against the code. They do not start a server, connect to HighLevel or Square, send messages, or change production data. The in-memory test vendors use the two addresses authorized for QA.

The current isolated suite covers:

- All 2,160 combinations of application, agreement, insurance, food-license requirement and food-license status in the test matrix. Only two complete states qualify for date selection.
- $30 full-season, $35 four-or-more consecutive market dates and $40 standard pricing, multiplied by final booth quantity.
- Every nonempty subset of a six-date test calendar; normalization, quantity scaling and complete quotes despite partial availability.
- Canonical calendar expansion, holiday gaps, duplicate dates, invalid dates, missing inventory, unsafe totals and invalid booth quantities.
- Four-food-truck and one-featured-nonprofit limits, nonprofit payment bypass, category validation and whitespace handling.
- Competing memory-store approvals, cancellation releasing capacity, no partial reservation on conflict, market isolation, removed booths, and public availability omitting vendor identities.
- Production secret requirements and rejection of tampered session tokens, including non-ASCII signatures.

Two regressions were reproduced before fixing them: memory-store approval of an inactive booth and a malformed Unicode session signature throwing a server error. Both now pass.

Additional September 7 coverage:

- Protected HighLevel application handoff: authorization, location/season validation, original contact/snapshot preservation, duplicate/conflict responses, failed persistence and oversized payloads. The isolated route tests use persistence doubles; the separate PostgreSQL suite below exercises the real handoff transaction.

- Six real route handlers reject null, arrays, scalar JSON and malformed JSON (36 payload cases) without mutations; missing authentication is rejected before reading admin mutation bodies. These routes are invoked in process with isolated external boundary doubles, not over HTTP.
- Late approval cannot revive rejected/cancelled memory-store bookings; repeated approvals skip duplicate HighLevel lifecycle sync. The matching PostgreSQL guard is covered in the booking-store suite below.
- Square sandbox configuration, stable checkout retry keys, exact cents/location, provider failures, invalid amounts and expired checkout refusal, HMAC verification (including the official independent sample), and exact completed-payment matching.
- Exactly 48 elapsed hours across both daylight-saving changes.
- The corrected Fresh Air season has 35 unique Saturdays from October 3, 2026 through May 29, 2027; a two-booth Full Season quote is $2,100.

These are component/contract passes. Square transport is replaced with a test double; no external payment is created. The authenticated final-reservation route, checkout route, durable webhook processing, and expiry worker are present, but account credentials, deployed database migrations, trusted scheduler, and real Sandbox deletion still need QA evidence.

## Limits of this evidence

The final CHECK/RESERVE writer is integrated into an authenticated portal route and deliberately reads no legacy booking row. These remain code-level tests, not proof of live workflow behavior. PostgreSQL migration/concurrency verification, public-form submissions, trigger-link routing, document signing, inbox delivery, duplicate workflow enrollment, Square payment outcomes and payment webhook replay must still be tested in their intended environments.

The configured Fresh Air account now uses its confirmed calendar. Other demo accounts and the existing booth-price calculation remain separate from the final Fresh Air pricing rules. Do not use the portal as the production reservation/payment system until the final migrations, explicit booth capacity, and deployed workflow verification are complete.

## Continuous integration

The repository workflow `.github/workflows/ci.yml` runs the isolated suite and a production build on pull requests and pushes to main using Node 22. It has read-only repository permissions, receives no production credentials, and does not deploy.

Five additional public inquiry route scenarios reject malformed text fields, invalid optional fields, text overflow and malformed/excessive dates; the positive scenario verifies email normalization, duplicate-date rejection, punctuation and market ownership. These are in-process route tests with a CRM double, not public-browser or real email evidence.


## Inquiry abuse protection

Nine new isolated cases cover IP/email limit responses, limiter failure without downstream writes/sends, bounded request bodies, concurrent in-memory boundaries, retention bounds, trusted-header handling and hashed identity scopes. See docs/inquiry-abuse-protection.md for policy and deployment requirements.

After npm test compiles the sources, npm run test:pg runs the PostgreSQL suites against a disposable local database. GitHub Actions supplies this service with DATABASE_TEST_URL; the suite rejects remote or non-test database URLs. The final-reservation suite applies migrations through `013`, races 100 exact retries and competing capacity requests, checks immutable provenance/quote guards, and forces a ledger failure to prove complete rollback. The expiry suite applies migrations through `015`, races market-scoped deadline claims, holds capacity until mocked provider cancellation proof confirms, checks durable retry backoff, null/future-mismatched deadline fencing, retry/404 exact-order recovery, parent-mapping/identity fences, legacy proofless-retirement quarantine, and a signed payment event during `expiry_pending` to manual review. The separate booking-store suite below covers existing booth approval transactions. They do not prove production deployment.

Five application-handoff database checks cover 100 concurrent duplicate deliveries across pools, conflicting event reuse, original application/snapshot preservation with later events, identity separation across contact/season/location/market, and full transaction rollback with successful exact retry over a new connection. The disposable database supplies only the accounts(id) prerequisite plus the actual additive handoff migration; full production schema compatibility and deployed CRM wiring remain unverified. No CRM contact, email or payment API is called.


## PostgreSQL booth booking tests

Five additional real-store scenarios verify twenty competing approvals and twenty concurrent replays, partial-date conflicts and cancellation/terminal-state handling, market isolation including inquiry creation, full rollback after a failed date insert, and committed state across fresh connections with inactive-booth rejection. The actual full schema initializer runs in a separate disposable schema. These tests exposed and now cover a schema-upgrade DDL parameter failure; inquiry writes also enforce active booth ownership inside the transaction. See docs/postgres-booking-verification.md for evidence scope and remaining production/CHECK/RESERVE gaps.


## Configured Fresh Air calendar

Five additional cases cover the 35-Saturday calendar, exact market/season configuration, New York date boundaries and retained admin history, real public/admin availability handlers, and inquiry acceptance/rejection before writes or CRM sync. Both server pages and all three relevant APIs share this calendar. Map selectors expose every supplied date. Browser verification, persisted production alignment and final pricing/quantity integration remain open; see docs/market-calendar-integration.md.
