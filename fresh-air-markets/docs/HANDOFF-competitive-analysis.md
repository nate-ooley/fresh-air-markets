# Handoff: competitive analysis for taking the Fresh Air Markets vendor portal to other US markets

## The question for the new chat

Research the software that farmers markets and event organizers in the US use to
manage vendors (applications, approvals, date/booth booking, payments, rosters,
vendor communication), compare their features and pricing to what we have built,
and recommend how to position and price our app for other markets. Deliver a
comparison table, gaps we should close, and a pricing recommendation.

Known competitors to start from: Marketspread, ManageMyMarket, Farmspread,
Eventeny, Zapplication, Submittable/Jotform-style form tools, Square Appointments
or HighLevel workflows used as makeshift systems. Verify current pricing on
their sites; do not rely on memory.

## What we have (as of September 22, 2026)

**Product:** a vendor portal for a single Saturday farmers market (North Port
Farmer's Market, run by Fresh Air Markets & Events, Florida). Live at
https://freshairmarketsandevents.com. One season (35 Saturdays, Oct 3, 2026 to
May 29, 2027). Real vendors and real payments are flowing.

**Stack:** Next.js 15 (App Router, TypeScript), PostgreSQL on Neon, hosting on
Vercel, email via Resend, payments via Square hosted checkout + webhooks, GitHub
Actions scheduler. Code: GitHub `nate-ooley/fresh-air-markets`. Roughly 435
unit tests and 180 database tests; 30 numbered SQL migrations.

**Vendor-facing features**
- Public marketing site with the vendor application form (contact, business,
  category, booths per day 1-4, requested Saturdays or full season, vendor
  agreement signed in-form, insurance/food-license upload with automatic image
  shrinking for phone photos).
- Pre-filled invitation links (used to migrate 21 applicants from HighLevel).
- Personal 14-day document upload link in every email.
- Private payment page via signed link; Square checkout; 48-hour payment window
  enforced by a scheduler that releases unpaid holds; receipt email.
- "Book more dates" self-serve link: vendor sees their bookings and which
  Saturdays have room for their category/booth count, requests dates; staff
  confirm with one click.
- Automatic emails: received, approved, changes requested, declined, payment
  request, payment received, booking withdrawn, application withdrawn, date
  request received/declined.

**Staff-facing features**
- Staff accounts with owner/manager roles, invitations, password reset.
- Application review queue with re-review after a vendor re-submits, document
  review (insurance expiry recorded and enforced), phone numbers for follow-up.
- Reservations: multiple bookings per vendor, per-booking pricing ($40 per
  Saturday, $35 when a booking is 4+ consecutive Saturdays, $30 full season,
  nonprofits free), capacity rules (55 vendor booths + 4 food-truck spaces per
  date, one featured nonprofit), reopen an expired hold, withdraw booking or
  application (Square link cancelled with proof), one-click confirm of vendor
  date requests.
- Market roster per date with category grouping, paid/pending status, and CSV
  download.
- Contact-form and newsletter capture; audit trails on every decision.

**Not built yet (known gaps)**
- Multi-market / multi-tenant admin (data model is per market account; the
  code is single-season, single-calendar today).
- Booth map / booth assignment, Vendor Pass, market-day reminders.
- Vendor login/dashboard beyond signed links; vendor-side cancellations.
- Reporting beyond the roster (revenue, attendance, no-shows).
- Refunds (done in Square), waitlists, tiered pricing by category, sponsorships.
- Text messaging (removed pending A2P approval).
- Insurance-expiry reminders, staff list of open date requests across vendors.

**Costs to run today (one market):** Vercel Hobby (to move to Pro, ~$20/mo),
Neon (free/launch tier), Resend (free tier), Square processing fees on
payments, domain. Effectively under $50/month excluding payment fees.

**Business context:** Nathan (Autocraft Studios) built this for a client. The
client's active manager is Thomas. The idea is to sell the same portal to
other markets across the US. Pricing of the app itself has not been decided.

## Deliverables wanted from the new chat
1. Feature-by-feature comparison table (us vs 4-6 competitors).
2. Their pricing models (per market / per vendor / per transaction / % of fees).
3. Gaps we must close to be sellable to a typical US farmers market or
   festival organizer, ranked by effort.
4. A recommended pricing model and launch positioning.
