# Fresh Air Markets & Events — Vendor Portal

**Live site:** https://freshairmarketsandevents.com
**Code:** GitHub `nate-ooley/fresh-air-markets` (app in `fresh-air-markets/`)
**Built by:** Autocraft Studios (Nathan Ooley) for Fresh Air Markets & Events
**Market manager:** Thomas Linzenmeyer
**Document date:** October 19, 2026 (code at commit `969dd1b`, database updates 001–035 applied)

This file has two parts:

1. **Session summary:** what was built and changed in the October 1 and October 15–16, 2026 work sessions.
2. **App reference:** every part of the portal (pages, screens, server routes, data, integrations, tests and how to run it).

No passwords, API keys or database connection strings are in this file. They live in Vercel environment settings and the Neon account.

---

## Part 1 — Session summary (October 1 and 15–16, 2026)

### At a glance

| Area | What changed | Status |
|---|---|---|
| Changing a vendor's dates | One-step "Change dates" with Saturday tiles and Review → Confirm and save | Live |
| Adding dates | Same tile picker and confirm step | Live |
| Pricing | A booking that includes 4+ Saturdays in a row is $35 on every date | Live |
| Billing one-off charges | Thomas bills from his own Square account, then "Record a payment" in the portal | Live |
| Payment reminders | Choose recipients, edit the email, preview before sending | Live |
| Vendor balances | Running balance per vendor; table of all vendors on the Roster | Live |
| Portal invoices / discounts / credits | Built and tested, **hidden** (switch: `SHOW_PORTAL_BILLING`) | Hidden by decision |
| Fixes | "Expired" payment page fixed; 120-day upload links; scheduler job fixed; staff wording | Live |

### Operational work on real vendors (October 1)

- **Dates changed for four vendors,** each moved from a full-season booking ($1,050) to October Saturdays. The old booking was withdrawn and a new payment link emailed:
  - Cristy's Cafe: Oct 3, 10, 17, 24 ($140)
  - Magical Pokémon, and toy chest: Oct 3, 10, 17 ($120)
  - Blue Akoya: Oct 3, 10, 17, 24 ($140)
  - Lizzy's Corner: Oct 3, 10, 17, 24 ($140)
- **Jennifer's Elegant Enhancements:** her insurance upload failed because her emailed upload link had expired (14-day links). Her certificate was uploaded for her; it is waiting for Thomas's review.
- **Heritage Bloom Farms:** the vendor payment page showed "payment window has ended" after the old 48-hour date even though links no longer expire. Fixed; a fresh link was sent and verified through to Square checkout. Heritage Bloom has since paid.

### Features built (October 15–16)

#### 1. Payment reminders with choice and preview
Roster → **Email payment reminders…** opens a panel:
- Tick which unpaid vendors get it; all are ticked to start.
- Edit the subject and message with per-vendor fill-ins: `{name}` `{business}` `{total}` `{dates}` `{link}`.
- Live preview of exactly what a chosen vendor receives.
- The private payment link is always included, even if `{link}` is removed.
- Skips bookings billed by invoice or with a changed price (discount, credit or payment taken in Square).

#### 2. Change dates in one step
On any unpaid booking:
1. **Change dates** → Saturday tiles.
2. **Review changes** → a summary of what's added and removed, plus the new total against the old.
3. **Confirm and save**.

What happens on save:
- **New dates are checked first,** counting the booking's own Saturdays as free: room, the vendor's other bookings, insurance expiry, and no new past dates. If any check fails, nothing changes.
- **The old Square payment link is cancelled with Square's confirmation** before the new booking is made.
- **The vendor gets one email** with old dates, new dates, new total and a new payment link.
- **Saturdays that already happened stay on the booking** and stay charged.
- **If a date is taken in the split second between check and save,** the original dates are put back.
- **A retry after a half-finished change** completes it instead of double-booking.

#### 3. Saturday tiles and confirm-before-save
Both "Add dates" and "Change dates" show the season as tiles grouped by month:

| Tile | Meaning |
|---|---|
| Dark green "Booked" | On this booking now |
| Faded green "Happened" | Past Saturday on the booking; locked and still charged |
| Orange "Adding" | Will be added |
| Red, crossed out "Removing" | Will be removed |
| White "Open" | Available |
| Grey dashed | Not available (reason shown: other booking, after insurance) |

Nothing is written until **Confirm and save**; **Go back** discards.

#### 4. Pricing rule change
- **Before:** the $35 rate applied only if every date in the booking was consecutive.
- **Now:** a booking that *includes* a run of 4 or more consecutive Saturdays is $35 on every date.
- **Other rates are unchanged:** $40 per Saturday standard, $30 full season, nonprofits free.
- **Bookings saved earlier keep their stored price.**

#### 5. Billing: Square account + "Record a payment"
- Thomas sends one-off or custom charges (partial amounts, payment plans, special prices) from **his own Square account**, on his phone app or computer.
- In the portal: **Record a payment** → amount, date, note → **Review payment** → **Confirm and save**.
- **Paid in full:** the booking becomes **Paid**. Its online payment link is cancelled first; if Square can't confirm the cancellation, nothing is saved.
- **Part payment:** the booking stays "awaiting payment" and the balance shows the remainder. The full-price link and reminders are turned off for that booking.
- **Undo** on the balance list reverses a mistake and reopens the booking if needed.

#### 6. Vendor balances
- **Vendor page → Balance:** booked, discounts, credits, paid and owed, plus a dated list with a running balance and Undo on staff entries.
- **Roster → Vendor balances:** every vendor's booked, paid and balance, linked to their page.

#### 7. Square invoices, discounts and credits (built, hidden)
Built, tested and verified live, then hidden by decision because Thomas bills from Square directly:
- **Bill this vendor:**
  - Pay in full, or a monthly plan of 2–12 payments.
  - Each payment is its own Square invoice, because Square refuses installment invoices without Invoices Plus (`403 MERCHANT_SUBSCRIPTION_NOT_FOUND`). Later payments are scheduled by Square for 3 days before they're due.
  - Square's invoice payments are matched back to the booking automatically.
- **Discount this booking:** a dollar amount or a percent, with a reason.
- **Add a credit:** for example a rain-out; used when billing.
- **Change amount** on a sent invoice: cancels its unpaid payments and sends new ones.
- **Live tests:**
  - Pay-in-full invoice: passed.
  - Cancel: passed.
  - Monthly plan as separate invoices: accepted by Square; the test plan was cancelled.

To turn these back on, set `SHOW_PORTAL_BILLING = true` in `src/components/FinalReservationPanel.tsx` and re-test.

#### 8. Fixes
- **Vendor payment page** no longer blocks payment after the old 48-hour date.
- **Staff payment wording** drops the "48-hour deadline"; links stay open until paid or withdrawn.
- **Emailed document-upload links** last 120 days (were 14). The server also accepts PDFs sent without a file type.
- **GitHub "payment recovery" scheduler job** stopped failing. It had been failing on every run since September 28 because of a response-format mismatch.

### Decisions made

| Decision | By |
|---|---|
| Payment links never expire; staff release spots with "Withdraw this booking" | Nathan (Sept 28) |
| Keep the lower $35 price when a 4-week run is part of a booking | Nathan (Oct 16) |
| Bill one-off charges from Square directly; record payments in the portal | Nathan (Oct 16) |
| Hide portal invoices, discounts and credits | Nathan (Oct 16) |
| Don't subscribe to Square Invoices Plus for now | Recommended (Square lists it at $20/month; confirm the $49 quote is the right plan) |
| Do not send any new invoices | Nathan (Oct 16) |

### Open items

- **Thomas to decide** whether vendors may set up before paying, since some unpaid bookings include past Saturdays (Asana task open).
- **Send the recap email to Thomas.** It's a Gmail draft: "Vendor portal update: changing dates, billing and balances"; add his address.
- **Jennifer's Elegant Enhancements:** Thomas to review and approve her insurance, approve the application, and book her dates.
- **Rotate the Neon database password** at some point (it was pasted in a chat on Sept 22).
- **Linear** is not connected; tasks are tracked in Asana (project "FAME Features & Fixes").
- **Test records** (Payments Test Co, Upload Link Test, Site Test Bakery, etc.) can be cleaned out.

### Tests at close
- **477** unit and route tests, all passing.
- **191** database tests against real PostgreSQL, all passing.
- **Production build** passes.
- Each feature was checked on the live site without changing real vendor data, except where noted above.

---

## Part 2 — App reference

### Technology

| Layer | Choice |
|---|---|
| App framework | Next.js 15 (App Router), TypeScript, React, Tailwind CSS |
| Hosting | Vercel (project `farmers-market`); every push to `main` deploys |
| Database | PostgreSQL on Neon (project `neon-green-car`, main branch), via `postgres.js` |
| Payments | Square: hosted checkout links, Orders, Invoices, webhooks (production) |
| Email | Resend, sender `hello@freshairmarketsandevents.com` |
| CRM (legacy/optional) | HighLevel (GoHighLevel) integrations and outbox delivery |
| Scheduled jobs | GitHub Actions (`payment-scheduler.yml`, every 5 min) calling internal cron routes |
| CI | GitHub Actions `ci.yml` (regression checks on push) |

### Season and pricing
- **Season:** 35 Saturdays, October 3, 2026 → May 29, 2027.
- **Capacity:** 55 vendor booths per Saturday, 4 food-truck spaces, one featured nonprofit.
- **Pricing per booth per Saturday:**
  - $40 standard.
  - $35 when the booking includes 4+ consecutive Saturdays.
  - $30 for the full season.
  - Nonprofits free.
- **Vendors can hold several bookings;** each is priced on its own dates.

### How a vendor moves through the portal

1. **Apply:** the vendor submits the form at `/apply`, signs the vendor agreement, and uploads insurance and food license (phone photos are shrunk automatically).
2. **Review:** staff approve, request changes or decline at `/applications/[id]`. Re-submissions reopen review.
3. **Documents:** staff approve the insurance (recording its expiry date) and food license if needed. Upload links in emails last 120 days.
4. **Book:** staff reserve Saturdays, which checks capacity, category rules and insurance expiry.
5. **Pay:** staff create a Square payment request and email the vendor a private payment page link. The link stays open until paid or withdrawn. Alternatively, Thomas bills in Square and records the payment.
6. **Paid:** Square's webhook marks the booking paid and the vendor gets a receipt plus a "book more dates" link.
7. **Changes:** Change dates, Withdraw booking or application, vendor date requests (confirm or decline), reminders.

### Pages

| Path | Who | Purpose |
|---|---|---|
| `/` | Public | Marketing home page |
| `/about`, `/vendors`, `/agreement` | Public | About, vendor info and FAQ, vendor agreement |
| `/apply` | Vendors | Application form with agreement and document upload |
| `/apply/documents` | Vendors | Upload documents from an emailed link |
| `/vendor/payment` | Vendors | Private payment page (signed link) → Square checkout |
| `/vendor/book` | Vendors | "Book more dates" request page (signed link) |
| `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/accept-invite` | Staff | Sign-in, staff invites, password reset |
| `/applications` | Staff | Application list |
| `/applications/[id]` | Staff | Review, documents, bookings, payments, balance, change dates, withdraw |
| `/roster` | Staff | Market roster per Saturday, season overview, payment reminders, vendor balances |
| `/messages` | Staff | Contact-form messages |
| `/staff` | Staff | Staff accounts and invitations |
| `/dashboard`, `/admin`, `/m/[slug]` | Legacy/demo | Earlier booth-map demo screens |

### Staff screens (components)

| Component | What it shows |
|---|---|
| `ApplicationReviewList` | Application list with status and resubmission flags |
| `ApplicationReviewPanel` | One application: details, decision, documents, withdraw, bookings |
| `ApplicationDocumentsPanel` | Insurance/license upload and review, expiry date, emailed upload link |
| `FinalReservationPanel` | Bookings: reserve, payment request, payment link email, record a payment, change dates, withdraw, booking requests, balance; hidden billing/discount/credit |
| `SaturdayPicker` | Saturday tiles (booked / happened / adding / removing / open / not available) |
| `RosterPanel` | Roster by date and category, season table, CSV |
| `PaymentRemindersCard` | Choose recipients, edit message, preview, send reminders |
| `VendorBalancesCard` | All vendors' balances on the Roster |
| `StaffPanel` | Staff users and roles |

Vendor-facing components: `ApplyForm`, `DocumentUploads`, `DocumentUploadPage`, `VendorPaymentPanel`, `VendorBookingPage`, `ContactForm`, `SiteChrome`.

### Server routes (API)

**Staff (`/api/admin/…`)** — require a signed-in manager; changes require same-site requests:

| Route | Purpose |
|---|---|
| `applications`, `applications/[id]/review`, `…/withdraw`, `applications/invite` | Review, withdraw, invite applicants |
| `applications/[id]/documents`, `documents/[id]/review`, `documents/[id]/file`, `…/upload-link` | Documents |
| `applications/[id]/reserve` | Read bookings; reserve dates |
| `applications/[id]/booking-request`, `booking-requests/[id]/confirm`, `…/decline` | Vendor date requests |
| `reservations/[id]/checkout`, `…/access`, `…/payment-email`, `…/reopen` | Square payment request, private link, email, reopen lapsed hold |
| `reservations/[id]/change-dates` | One-step date change |
| `reservations/[id]/withdraw` | Withdraw an unpaid booking (Square link cancelled with proof) |
| `reservations/[id]/manual-payment`, `manual-payments/[id]/void` | Record / undo a payment taken in Square |
| `applications/[id]/balance`, `balances` | Vendor balance; all balances |
| `payments/reminders` | List unpaid / send chosen reminders |
| `reservations/[id]/invoice`, `invoices/[id]/cancel`, `applications/[id]/invoices` | Square invoices (hidden in UI) |
| `reservations/[id]/discount`, `applications/[id]/credit`, `adjustments/[id]/void` | Discounts and credits (hidden in UI) |
| `roster`, `staff`, `messages`, `overview` | Roster, staff, messages |

**Vendor:** `/api/apply`, `/api/apply/documents`, `/api/apply/prefill`, `/api/vendor/access`, `/api/vendor/payment`, `/api/vendor/booking`, `/api/vendor/logout`, `/api/contact`.

**Payments:** `/api/payments/square/webhook` — signed Square payment events. Matched to checkout orders or invoice payments; unmatched events are held for review.

**Scheduled (`/api/internal/cron/…`)**, protected by `CRON_SECRET`:
- `payment-email`
- `payment-pending-sync`
- `payment-paid-sync`
- `application-review-outbox`
- `agreement-completion-stage-outbox`
- `square-payment-expiry` (answers `{ enabled: false }` while expiry is off)

**HighLevel integrations (`/api/integrations/…`):** application, agreement, document and workflow webhooks.

### Main server libraries (`src/lib`)

| File | Responsibility |
|---|---|
| `final-reservation(-pg).ts` | Reserving dates, eligibility, capacity, insurance expiry, date-change planning |
| `vendor-booking-rules.ts` | Pricing and capacity rules |
| `reservation-withdraw-pg.ts` | Withdraw booking/application; retire Square links with proof |
| `square.ts`, `square-payment(-pg).ts`, `square-link-cancel.ts` | Square checkout links and cancellation |
| `square-webhook(-pg).ts` | Verify and apply Square payment events |
| `square-invoice.ts`, `vendor-invoice-pg.ts`, `invoice-cancel.ts`, `billing-plan.ts` | Square invoices and plans (hidden) |
| `vendor-balance-pg.ts` | Balances, discounts, credits, recorded Square payments |
| `vendor-payment-access(-pg).ts`, `vendor-payment-view.ts` | Private vendor payment links and sessions |
| `vendor-booking-pg.ts` | Vendor "book more dates" requests |
| `notifications.ts`, `email.ts`, `email-templates.ts`, `payment-reminder-template.ts` | All vendor and staff emails |
| `application-*.ts` | Applications, review, documents, upload tokens |
| `market-roster.ts` | Roster and season totals |
| `auth.ts`, `staff-users.ts`, `password-*.ts` | Staff sign-in and accounts |
| `ghl-*.ts`, `highlevel-workflow-intake.ts` | HighLevel delivery and intake |

### Database (PostgreSQL)

Migrations live in `docs/migrations` (001–035) and are applied in order by `scripts/database-readiness.mjs`. Key tables:

| Table | Holds |
|---|---|
| `fame_applications`, `fame_application_events`, `fame_application_review_events` | Applications and their history |
| `fame_application_documents`, private document objects | Insurance and license files (private) with review and expiry |
| `fame_agreement_completions` | Signed vendor agreements |
| `fame_reservations`, `fame_reservation_finalizations`, `fame_reservation_allocations` | Bookings, their provenance and per-Saturday allocations |
| `fame_payment_orders`, `fame_square_webhook_events` | Square checkout orders and payment receipts |
| `fame_vendor_payment_invitations`, `fame_vendor_payment_sessions` | Private vendor payment links |
| `fame_booking_requests` | Vendor date requests |
| `fame_invoices`, `fame_invoice_installments`, `fame_invoice_payments` | Square invoices (032–033) |
| `fame_vendor_adjustments` | Discounts and credits (034) |
| `fame_manual_payments` | Payments recorded from Square (035) |
| `fame_email_log` | Every email sent |
| Outbox tables | Reliable delivery to HighLevel and the email queue |

### Settings (environment variables, set in Vercel)

| Group | Variables |
|---|---|
| Market | `FAME_MARKET_ACCOUNT_ID`, `FAME_SEASON_ID`, `FAME_BOOTH_CAPACITY`, `FAME_VENDOR_PORTAL_ORIGIN` |
| Payment behaviour | `FAME_PAYMENT_AUTO_EXPIRY` (off = links never expire), `FAME_PAYMENT_SCHEDULER_ENABLED` |
| Database | `DATABASE_URL`, `DATABASE_URL_UNPOOLED` |
| Square | `SQUARE_ENVIRONMENT`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_MERCHANT_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL`, `SQUARE_ALLOW_LIVE_PAYMENTS` |
| Email | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `STAFF_NOTIFY_EMAIL` |
| Security | `AUTH_SECRET`, `CRON_SECRET`, document webhook secrets |
| HighLevel | `GHL_*` (location, pipelines, stages, fields, webhook secrets, delivery switches) |

### Running, testing and deploying

```bash
cd fresh-air-markets
npm install
npm run dev          # local site
npm test             # 477 unit and route tests
npm run build        # production build
```

```bash
DATABASE_TEST_URL="postgres://<user>@127.0.0.1:5432/fresh_air_test" npm run test:pg   # 191 database tests
```

- **Deploy:** push to `main` on GitHub; Vercel builds and publishes automatically.
- **Database updates:** apply new migrations to production *before* pushing code that needs them. Use `node scripts/database-readiness.mjs apply --production --expected-host=<neon host>` with the production `DATABASE_URL`, which the Neon CLI can print for the signed-in account.

### Security notes

- **Staff routes** check the signed session and the configured market, and reject cross-site requests.
- **Vendor links** are signed, single-purpose tokens kept in the URL fragment, not sent to servers in query strings.
- **Square webhooks** are verified by signature. Payments are matched by exact order identity, and anything unexpected is held for review rather than trusted.
- **Square links are cancelled only with proof:** before a booking is withdrawn, re-dated or marked paid, the old link must be confirmed cancelled by Square.
- **Vendor documents** are stored privately and served only to signed-in staff.
- **Mistakes are voided, never deleted:** staff entries (payments, discounts, credits) keep a full history.

### Related documents in `docs/`

`HANDOVER.md`, `vendor-emails.md`, `CHANGES-2026-09-10.md`, `HANDOFF-competitive-analysis.md`, `database-readiness.md`, `square-production-runtime.md`, `payment-scheduler.md`, `final-reservation.md`, `vendor-payment-journey.md`, and the HighLevel and Square setup runbooks.
