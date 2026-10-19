# Fresh Air Markets & Events — Vendor Portal: Complete Overview

**Live site:** https://freshairmarketsandevents.com (staff sign in at `/login`)
**Code:** GitHub `nate-ooley/fresh-air-markets` (app in `fresh-air-markets/`)
**Built by:** Autocraft Studios (Nathan Ooley) for Fresh Air Markets & Events (North Port Farmer's Market)
**Market manager:** Thomas Linzenmeyer
**As of:** October 19, 2026 (code `main`; database updates 001–035 applied)

**Contents**
1. Project history (September 9 → October 16, 2026)
2. Latest session in detail (October 1 and October 15–16)
3. Every component of the app (marketing site, application, staff admin panel, legacy admin dashboard, bookings, Square, billing and balances, email, HighLevel, scheduler, staff accounts, database, settings, scripts, testing, security)
4. Open items and decisions

No passwords, API keys or database connection strings are in this file. They live in Vercel environment settings, GitHub secrets and the Neon account.

---

## 1. Project history

| When | Milestone |
|---|---|
| **Before Sept 10** | **Starting point.** Booth-map SaaS demo (`/dashboard` admin, `/m/[slug]` public booking, Starter/Pro/Season Pass plans). Then PR #1 added application review, the vendor agreement, documents, reservations and Square payments, driven by HighLevel webhooks. Production ran an in-memory demo store with no database. QA history: `docs/asana-test-history-20260909.md`. |
| **Sept 10** | **Production database.** Production migration path, manager creation, demo tenant blocked in Production, `scripts/production-bringup.sh`. PR #1 merged and deployed. |
| **Sept 10** | Staff document upload and review, with files stored privately in PostgreSQL. HighLevel native workflow adapter (later unused). |
| **Sept 10–11** | **The marketing site and vendor application moved into the portal** (home, vendors, about, apply, agreement, staff inbox), with no CRM in the loop. |
| **Sept 11** | Email through Resend (sender verified), with a send log. |
| **Sept 11** | 1–4 booths per day on the application. Pre-filled application invitations; 21 HighLevel applicants were invited. |
| **Sept 11** | Market roster with CSV export. Staff accounts with owner/manager roles. Staff password reset. |
| **Sept 11** | **First real $40 card payment proven end to end in production.** |
| **Sept 12** | Vendor phone number required and shown to staff. Payment-link email reworked. |
| **Sept 15** | Reopen an expired hold. Vendor replies go to hello@. |
| **Sept 17** | Re-submitted applications flagged for review. Document upload counts as the answer to "changes requested". Emailed document-upload links. Staff "Email the vendor an upload link". |
| **Sept 18** | Phone-photo uploads shrunk in the browser (Vercel's 4.5 MB limit); HEIC and oversized-PDF handling. |
| **Sept 21–22** | **Vendor bookings:** several bookings per vendor; withdraw a booking or application (Square link cancelled with proof); re-review after re-submission; vendor "book more dates" requests confirmed or declined by staff; insurance expiry recorded and enforced. |
| **Sept 22** | Competitive-analysis handoff brief (`docs/HANDOFF-competitive-analysis.md`). |
| **Sept 28** | **Payment links stay open** (no 48-hour release). One-click payment reminders. Reminders emailed to 7 vendors. |
| **Oct 1** | Dates changed for 4 vendors. Jennifer's insurance uploaded. Upload links extended to 120 days. "Expired" payment page fixed (Heritage Bloom). Scheduler job fixed. Staff wording updated. |
| **Oct 15** | Payment reminders with choice and preview. One-step Change dates. |
| **Oct 15–16** | Square invoices and monthly plans built and tested live, then hidden. Vendor balances, discounts and credits. Past Saturdays hidden. Saturday tiles with confirm-before-save. $35 rule kept. "Record a payment taken in Square". |
| **Oct 16** | Recap email to Thomas drafted in Gmail. Asana closed out. |
| **Oct 19** | This overview. |

---

## 2. Latest session in detail (October 1 and October 15–16)

### Work on real vendors (October 1)
- **Dates changed for four vendors,** each moved from a full-season booking ($1,050) to October Saturdays, with a new payment link emailed:
  - Cristy's Cafe: Oct 3, 10, 17, 24 ($140)
  - Magical Pokémon, and toy chest: Oct 3, 10, 17 ($120)
  - Blue Akoya: Oct 3, 10, 17, 24 ($140)
  - Lizzy's Corner: Oct 3, 10, 17, 24 ($140)
- **Jennifer's Elegant Enhancements:** her insurance upload failed on an expired 14-day link. Her certificate was uploaded for her and awaits Thomas's review.
- **Heritage Bloom Farms:** the payment page showed "window ended" after the old 48-hour date. Fixed, re-sent and verified through to Square checkout. Heritage Bloom has since paid.

### Features built (October 15–16)

**Payment reminders with choice and preview**
Roster → **Email payment reminders…**:
- Tick which unpaid vendors get it.
- Edit the subject and message with fill-ins `{name}` `{business}` `{total}` `{dates}` `{link}`; the link is always included.
- Live preview of exactly what each vendor receives before sending.
- Bookings billed by invoice or with a changed price are skipped.

**Change dates in one step**
- **Flow:** Saturday tiles → **Review changes** (added and removed dates, new total against old) → **Confirm and save**.
- **Checks first:** room, the vendor's other bookings, insurance expiry, and no new past dates. If any fail, nothing changes.
- **The old Square link is cancelled with Square's confirmation** before the new booking is made.
- **The vendor gets one email** with old dates, new dates, total and a new link.
- **Past Saturdays stay on the booking** and stay charged.
- **A date taken in the split second between check and save** puts the original dates back. A half-finished change resumes on retry.

**Saturday tiles and confirm-before-save** (Add dates and Change dates)

| Tile | Meaning |
|---|---|
| Dark green "Booked" | On this booking |
| Faded green "Happened" | Past, locked, still charged |
| Orange "Adding" / Red "Removing" | The change being made |
| White "Open" | Available |
| Grey dashed | Not available, with the reason |

Nothing is written until **Confirm and save**.

**Pricing rule**
- A booking that *includes* 4+ consecutive Saturdays is $35 on every date. Before, all dates had to be consecutive.
- Other rates are unchanged.
- Bookings saved earlier keep their stored price.

**Billing: Square account plus "Record a payment"**
- Thomas bills one-off or custom charges from his own Square account, on his phone or computer.
- In the portal: **Record a payment** → amount, date, note → **Review payment** → **Confirm and save**.
- **Paid in full:** the booking becomes Paid. Its online link is cancelled first; if Square can't confirm, nothing is saved.
- **Part payment:** the remainder shows on the balance. The full-price link and reminders are turned off for that booking.
- **Undo** reopens the booking if needed.

**Vendor balances**
- **Vendor page:** booked, discounts, credits, paid and owed, with a dated running list and Undo.
- **Roster:** "Vendor balances" for every vendor.

**Square invoices, discounts and credits (built, tested, hidden)**
- **What was built:**
  - Bill this vendor: pay in full, or a monthly plan of 2–12 payments, each sent as its own Square invoice and scheduled 3 days before due.
  - Discounts (dollar amount or percent, with a reason).
  - Credits.
  - "Change amount" on a sent invoice.
- **Live tests:** pay-in-full invoice passed; cancel passed; the monthly plan was accepted by Square, then the test plan was cancelled.
- **Why plans are separate invoices:** Square refuses installment invoices without Invoices Plus (`403 MERCHANT_SUBSCRIPTION_NOT_FOUND`).
- **Hidden** because Thomas bills from Square directly. To re-enable, set `SHOW_PORTAL_BILLING = true` in `src/components/FinalReservationPanel.tsx`.

**Fixes**
- The vendor payment page no longer blocks payment after the old pay-by date.
- Staff wording drops the "48-hour deadline".
- Upload links last 120 days, and PDFs without a file type are accepted.
- The scheduler job has passed since the fix (it had failed every run since Sept 28).

**Tests at close:** 477 unit and route tests and 191 database tests pass, and the production build passes.

---

## 3. Every component of the app

### 3.1 Technology and infrastructure

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router), TypeScript, React, Tailwind CSS |
| Hosting | Vercel project `farmers-market` (Hobby; Pro recommended for commercial use). Push to `main` deploys. Custom domain `freshairmarketsandevents.com`. |
| Database | Neon PostgreSQL, project `neon-green-car`, main branch (preview branches are created for pull requests) |
| Payments | Square production: merchant ML16MNPG8Z0R5; hosted checkout links, Orders, Invoices, Customers, webhooks |
| Email | Resend, sender `hello@freshairmarketsandevents.com` (DKIM/SPF verified Sept 11) |
| CRM | HighLevel (GoHighLevel): integrations built, now dormant |
| Scheduler | GitHub Actions `payment-scheduler.yml`, every 5 minutes |
| CI | GitHub Actions `ci.yml`: unit tests plus database tests on PostgreSQL 17 and 18 |

**Season settings:**
- 35 Saturdays, Oct 3, 2026 → May 29, 2027.
- 55 vendor booths and 4 food-truck spaces per Saturday, one featured nonprofit.
- $40 per booth per Saturday; $35 when the booking includes 4+ in a row; $30 for the full season; nonprofits free.

### 3.2 Public marketing site
- **`/` home:** market info, newsletter signup and contact form (saved to `fame_contact_messages` and `fame_newsletter_subscribers`; staff email).
- **`/vendors`:** benefits, requirements, fees and FAQ.
- **`/about`, `/agreement`:** about page and the vendor agreement text.
- **Shared header and footer** (`SiteChrome`), logo and images in `public/site/`.
- **Spam protection:** contact and inquiry rate limiting (`inquiry-rate-limit(-pg)`) and duplicate protection (`inquiry-idempotency`).

### 3.3 Vendor application and documents
- **`/apply` (`ApplyForm`):**
  - Contact details (phone required), business, category, 1–4 booths per day, full season or specific Saturdays.
  - Typed signature accepting the vendor agreement.
  - Upload insurance and food license right away. Phone photos are shrunk in the browser (`upload-prepare`), HEIC is handled, oversized PDFs get a clear message.
- **Pre-filled invitations** (`/api/admin/applications/invite`, `/api/apply/prefill`): personal links with details filled in.
- **`/apply/documents` (`DocumentUploadPage`):** upload from an emailed link (signed token, 120 days).
- **Document storage:**
  - Files are kept privately in PostgreSQL, with a version history per document (`application-document*`, `private-document-*`).
  - Every upload passes type, size and file-signature checks.
  - Staff approve with the insurance expiry date.
- **Re-submission:** updated applications show as "Updated · needs review" and can be re-reviewed.

### 3.4 Staff admin panel (the live portal)
Signed-in staff (owner or manager):

| Screen | What staff do there |
|---|---|
| `/applications` (`ApplicationReviewList`) | All applications with status, resubmission flags and phone numbers |
| `/applications/[id]` (`ApplicationReviewPanel`) | Review (approve, request changes, decline, with a note to the vendor); withdraw the application |
| — Vendor documents (`ApplicationDocumentsPanel`) | Upload or review insurance and license, record the expiry date, email the vendor an upload link |
| — Bookings (`FinalReservationPanel`, `SaturdayPicker`) | Reserve dates (tiles, Review, Confirm), create a Square payment request, email the private payment link, copy the link, reopen an expired hold, Change dates, Withdraw a booking, confirm or decline vendor date requests, Record a payment taken in Square, Balance |
| `/roster` (`RosterPanel`) | Vendors per Saturday by category, pending payments, season table, CSV download; Payment reminders (`PaymentRemindersCard`); Vendor balances (`VendorBalancesCard`) |
| `/messages` | Contact-form messages |
| `/staff` (`StaffPanel`) | Invite managers by email, remove them; owner and manager roles |
| Square webhook check (`/api/admin/square/webhook`) | GET reports whether Square's webhook URL matches the site; POST re-aligns it (`square-webhook-subscription`) |

### 3.5 Legacy admin dashboard (booth-map product)
The original multi-market booth-booking product. It's still in the code and used only by non-Fresh-Air or demo accounts; the Fresh Air account is redirected to `/applications`.
- **`/dashboard` (`AdminDashboard`):**
  - Stats per market weekend.
  - **Map editor:** add, edit and delete booths on a market map (`MarketMap`, `/api/admin/booths`).
  - **Verification board:** approve or verify vendor bookings (`/api/admin/bookings/[id]`).
  - Vendor roster; uses `/api/admin/overview`.
- **`/admin`:** redirects to `/dashboard`.
- **`/m/[slug]` (`MarketBooking`, `BookingPanel`):** public booth-booking page per market (`/api/m/[slug]/booths`, `/api/m/[slug]/inquiries`).
- **`/signup`:** market sign-up with plans (`plans.ts`): Starter $29, Pro $79, Season Pass $790.
- **Data layer:** demo tenant and seed data (`demo-tenant`, `seed`, `store`, `store-memory`, `store-pg`). The demo login is blocked in Production.
- **Landing demo map:** `LandingDemoMap`.

### 3.6 Bookings and reservations
- **Several bookings per vendor**, each with its own price, Square link and history.
- **The reservation writer** (`final-reservation(-pg)`) checks:
  - Approval of the current submission, signed agreement, approved insurance and food license.
  - Capacity (booths, food trucks, nonprofit) under database locks, overlap with the vendor's own bookings, and insurance expiry.
  - A retry or double click produces the same booking, never a second one.
- **Pricing and capacity rules:** `vendor-booking-rules`.
- **Records:** every booking keeps an immutable record of the approval, agreement and documents it relied on; each Saturday is recorded separately.
- **Withdraw** (`reservation-withdraw-pg`): the booking or the whole application. The Square link is deleted with proof first; vendor links are revoked and the vendor is emailed.
- **Change dates** (`planDateChange` plus the `change-dates` route); **reopen an expired hold**.
- **Vendor "book more dates"** (`/vendor/book`, `vendor-booking-pg`): the vendor picks open Saturdays; staff confirm in one click (book, Square request, email) or decline with a note.

### 3.7 Square integration (complete)

| Piece | What it does | Files |
|---|---|---|
| Configuration and safety fences | Sandbox vs production; live payments only with `SQUARE_ALLOW_LIVE_PAYMENTS=true` on Vercel Production; production must be pinned to one merchant and location; checkout only from the portal's own domain | `square.ts`, migration 016, `docs/square-production-runtime.md` |
| Identity check | Before any write, confirms the access token's merchant is active and the location belongs to it | `verifySquareIdentity` |
| Hosted checkout links | Creates a Square payment link per booking with a stable retry key; never takes a price from the browser | `createSquareCheckout`, `square-payment(-pg)` |
| Payment order record | One record per payment attempt (pending → processing → link created → paid / expired / cancelled / needs review), with locking so two clicks can't create two links; re-issued after failure or reopen (027–028) | `fame_payment_orders`, migrations 011, 027, 028, `docs/square-checkout-ledger.md` |
| Private vendor payment page | Signed, private link in an email → session → Square checkout; links never expire (Sept 28) | `vendor-payment-access(-pg)`, `vendor-payment-view`, `/vendor/payment`, migration 017/031 |
| Webhook | Verifies Square's signature on the raw body; records each event once; matches by exact merchant, location and order; marks the booking paid; holds mismatches (amount, merchant, late, unknown order) for staff review | `square-webhook(-pg)`, `/api/payments/square/webhook`, migration 012 |
| Webhook URL sync | Admin check and fix so Square's stored webhook URL matches the site's domain | `square-webhook-subscription`, `/api/admin/square/webhook` |
| Link cancellation with proof | Delete the link, then confirm the order is cancelled before releasing dates, re-dating, invoicing or recording a payment | `square-link-cancel` |
| Expiry worker | Releases unpaid holds after 48 hours, with a retry schedule; switched off since Sept 28 (`FAME_PAYMENT_AUTO_EXPIRY`); answers `{ enabled: false }` | `/api/internal/cron/square-payment-expiry`, migrations 014–015, `docs/square-payment-expiry.md` |
| Payment emails | Payment request, reminder (customizable), payment received (with a "book more dates" link), staff payment notice | `notifications`, `email-templates`, `payment-email(-pg)` |
| Invoices (hidden) | Square customer → order → draft invoice → retire old link → publish; one invoice per payment for plans; cancel; payments matched by order | `square-invoice`, `vendor-invoice-pg`, `invoice-cancel`, `billing-plan`, migrations 032–033 |
| Payments taken in Square | Staff record payments made outside the portal | `vendor-balance-pg` (`recordManualPayment`), migration 035 |
| Sandbox and QA tools | Sandbox setup and verification, QA fault injection (Preview only, never in Production), signed test webhook fixtures and dispatcher | `square-qa-faults`, `scripts/verify-square-sandbox.mjs`, `scripts/square-qa-webhook.mjs`, `scripts/generate-square-qa-webhook-fixture.mjs`, `docs/square-sandbox-setup.md`, `docs/square-sandbox-qa-matrix.md` |

### 3.8 Billing, balances and price changes
- **Vendor balance** (`vendor-balance-pg`, `/api/admin/applications/[id]/balance`, `/api/admin/balances`):
  - Every charge from live bookings, plus discounts, credits and payments (checkout, invoice, recorded in Square).
  - A running total, and Undo on staff entries.
- **Recorded Square payments:** visible and in use (see section 2).
- **Discounts and credits** (`fame_vendor_adjustments`): built, hidden.
- **Guards:** a booking with a changed price, a part payment, or an open invoice can't use the full-price link, reminders, or Change dates.

### 3.9 Email system
Sent through Resend; every attempt is logged in `fame_email_log`. Wording for each is in `docs/vendor-emails.md`.
- **To vendors:**
  - Finish-your-application invitation; application received; approved; changes requested; declined.
  - Upload link; payment request; payment reminder (customizable); payment received.
  - Booking withdrawn; application withdrawn; dates changed; date request received; date request declined.
- **To staff:** new or updated application; contact message; date request; payment received; staff invitation; password reset.
- **Not built yet:** market-day reminders, Vendor Pass or booth assignment, insurance-expiry reminders.

### 3.10 HighLevel (GoHighLevel) integration — dormant
Built for the original CRM-driven flow; every worker reports `{ enabled: false }` without HighLevel settings.
- **Inbound webhooks** (`/api/integrations/highlevel/…`): applications, agreements issued and completed, documents, native workflow intake (`highlevel-workflow-intake`).
- **Outbound sync** of application review stages, agreement stages and payment status to HighLevel opportunities, with delivery receipts (`ghl-*`, migrations 004–010, 018–021).
- **Document ingress and scanner webhooks** (`/api/integrations/documents…`).
- **Remaining cleanup:** turn off old HighLevel workflows and delete test contacts.

### 3.11 Scheduler and background workers
- **GitHub Actions `payment-scheduler.yml`** runs `scripts/run-payment-scheduler.mjs` every 5 minutes (`FAME_PAYMENT_SCHEDULER_ENABLED`, secret `CRON_SECRET`).
- **It calls, in order:**
  - `application-review-outbox`
  - `agreement-completion-stage-outbox`
  - `payment-pending-sync`
  - `payment-email`
  - `payment-paid-sync`
  - `square-payment-expiry`
- **Workers that are switched off** report "skipped", so the job stays green.

### 3.12 Staff accounts and sign-in
- **Accounts:** staff users with owner and manager roles, invitation by email (`/accept-invite`), removal (`fame_staff_users`, migration 026).
- **Password reset:** single-use 30-minute link (`fame_password_resets`, migration 025).
- **Session:** a signed session tied to the market (`auth`, `AUTH_SECRET` of 32+ characters). Every staff route checks it and rejects cross-site requests (`admin-gate`).

### 3.13 Database (PostgreSQL, migrations 001–035)
Applied in order by `scripts/database-readiness.mjs` (`plan` / `check` / `apply --production --expected-host=…`). Every table is scoped by market.

| Group | Tables / migrations |
|---|---|
| Applications | `fame_applications`, `fame_application_events`, `fame_application_review_events` (001, 008, 010, 023) |
| Agreement | `fame_agreement_completions` and stage outbox (005, 007, 009) |
| Documents | `fame_application_documents`, private document objects (006, 022, 030 expiry) |
| Bookings | `fame_reservations`, finalizations, allocations (011, 013, 029), `fame_booking_requests` (030) |
| Square payments | `fame_payment_orders` (011, 014–016, 027–028), `fame_square_webhook_events` (012) |
| Vendor payment access | invitations and sessions (017, 031) |
| Outboxes | review, agreement, payment email, paid sync, pending sync, delivery receipts (004–005, 018–021) |
| Site | contact messages, newsletter, rate limit, idempotency (002–003, 023) |
| Email / staff | `fame_email_log` (024), `fame_password_resets` (025), `fame_staff_users` (026) |
| Billing | `fame_invoices`, installments, invoice payments (032–033), `fame_vendor_adjustments` (034), `fame_manual_payments` (035) |

### 3.14 Settings (environment variables, set in Vercel)

| Group | Variables |
|---|---|
| Market | `FAME_MARKET_ACCOUNT_ID`, `FAME_SEASON_ID`, `FAME_BOOTH_CAPACITY`, `FAME_VENDOR_PORTAL_ORIGIN` |
| Payment behaviour | `FAME_PAYMENT_AUTO_EXPIRY` (off = links never expire), `FAME_PAYMENT_SCHEDULER_ENABLED` (GitHub variable) |
| Database | `DATABASE_URL`, `DATABASE_URL_UNPOOLED` |
| Square | `SQUARE_ENVIRONMENT`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_MERCHANT_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL`, `SQUARE_ALLOW_LIVE_PAYMENTS` |
| Email | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `STAFF_NOTIFY_EMAIL` |
| Security | `AUTH_SECRET`, `CRON_SECRET`, `DOCUMENT_INGRESS_WEBHOOK_SECRET`, `DOCUMENT_SCANNER_WEBHOOK_SECRET` |
| HighLevel | `GHL_*` (location, pipelines, stages, fields, template, webhook secrets, delivery switches) |

### 3.15 Scripts and tools (`fresh-air-markets/scripts`)

| Script | Purpose |
|---|---|
| `database-readiness.mjs` | Plan, check and apply migrations; checks production readiness |
| `production-bringup.sh` | One-shot production database bring-up (manager account, migrations, checks) |
| `bootstrap-qa-account.mjs` | Create a QA market account on a preview database |
| `delete-application.mjs` | Permanently remove one application and everything attached to it |
| `run-payment-scheduler.mjs` | The 5-minute scheduler run by GitHub Actions |
| `verify-square-sandbox.mjs` | Check Square sandbox credentials and location |
| `square-qa-webhook.mjs`, `generate-square-qa-webhook-fixture.mjs` | Build and send signed test Square webhooks (Preview only) |
| Neon CLI | `npx neon@latest connection-string <branch> --project-id <id>` prints the production database address for the signed-in account (used for migrations 032–035) |

### 3.16 Testing and quality
- **`npm test`:** 477 unit and route tests (pricing, schedules, emails, every API route with stubbed services, staff screens).
- **`npm run test:pg`:** 191 tests against a real PostgreSQL. Each runs in its own private schema: bookings, capacity locks, withdraw, change dates, Square webhook matching, invoices, balances, recorded payments, migrations.
- **CI runs both** on every push; the production build is checked before each push.
- **QA runbooks:** `docs/l06-l08-deployment-qa-runbook.md`, `docs/l06-l08-qa-matrix.md`, `docs/postgres-booking-verification.md`.

### 3.17 Security
- **Staff routes:** signed session, market match, same-site requests only.
- **Vendor links:** signed, single-purpose tokens kept in the URL fragment; sessions can be revoked.
- **Square:**
  - Webhook signature verified; payments matched by exact identity, and anything unexpected held for review.
  - Old links are cancelled with proof before dates are released or a booking is marked paid.
  - Live payments are fenced to Production.
- **Data handling:**
  - Documents are private and served only to staff.
  - Mistaken staff entries are voided, never deleted.
  - No vendor names or emails go into Square metadata.
- **Spam protection:** public forms are rate-limited and duplicate-protected.

### 3.18 Documents in `docs/`
- **Status and history:** `HANDOVER.md`, `CHANGES-2026-09-10.md`, this file.
- **Email:** `vendor-emails.md`.
- **Database:** `database-readiness.md`, `production-database-bringup.md`.
- **Square:** `square-production-runtime.md`, `square-checkout-ledger.md`, `square-payment-expiry.md`, `square-sandbox-setup.md`, `square-sandbox-qa-matrix.md`, `vendor-payment-access.md`, `vendor-payment-journey.md`, `payment-*`.
- **HighLevel:** `highlevel-*`, `agreement-completion-integration.md`, `application-review-outbox.md`.
- **Other:** `market-calendar-integration.md`, `inquiry-*`, `HANDOFF-competitive-analysis.md`.

---

## 4. Open items and decisions

**Waiting on people**
- **Thomas to decide** whether vendors may set up before paying (some unpaid bookings include past Saturdays).
- **Nathan to send the recap email to Thomas** (Gmail draft "Vendor portal update: changing dates, billing and balances"; add his address).
- **Jennifer's Elegant Enhancements:** Thomas to approve her insurance and application, then book her dates.

**Housekeeping**
- **Rotate the Neon database password** (it was pasted in a chat on Sept 22).
- **Move Vercel from Hobby to Pro** (Hobby is for non-commercial use).
- **Turn off old HighLevel workflows** and delete test contacts.
- **Clear test records** (Payments Test Co, Upload Link Test, Site Test Bakery, etc.).
- **Connect Linear** if wanted; tasks are tracked in Asana ("FAME Features & Fixes", "Fresh Air Markets").

**Decisions on record**

| Decision |
|---|
| Payment links never expire; staff release spots with "Withdraw this booking" (Sept 28) |
| Keep $35 when a 4-week run is part of a booking (Oct 16) |
| Thomas bills one-off charges from his Square account; payments recorded in the portal (Oct 16) |
| Portal invoices, discounts and credits hidden (Oct 16) |
| No new invoices to be sent (Oct 16) |
| Square Invoices Plus not needed for now (Square lists it at $20/month; confirm what the $49 quote covers) |

**Ideas for later**
- A staff list of open date requests across all vendors.
- Insurance-expiry and market-day reminders.
- Vendor Pass and booth assignment.
- An "Add a vendor" screen for walk-ups.
- Multi-market version (see `HANDOFF-competitive-analysis.md`).
