# Fresh Air Markets portal — status and handover (September 21, 2026)

## Live today

Site: https://freshairmarketsandevents.com (staff sign in at `/login`).
Hosting: Vercel project `farmers-market`. Database: Neon PostgreSQL, migrations 001–030.
Payments: Square production, merchant ML16MNPG8Z0R5, webhook on the custom domain.
Email: Resend from `hello@freshairmarketsandevents.com` (domain verified).
Scheduler: GitHub Actions every 5 minutes, releases unpaid 48-hour holds.

Proven end to end on production with a real $40 card payment:
apply → staff approve → insurance uploaded and approved → reservation →
Square checkout → private vendor link → payment → webhook marks paid →
vendor and staff confirmation emails.

Also live: vendor upload of insurance right after applying, 1–4 booths per
market day, contact form and newsletter, staff password reset by emailed link,
an admin endpoint that keeps Square's webhook URL aligned with the site,
staff accounts (the owner invites managers from `/staff`), the market
roster at `/roster` with a per-date spreadsheet download, and vendor
bookings (September 21): an approved application is the vendor's profile for
the season and can hold several bookings, each with its own payment link and
priced on its own dates ($40 a Saturday, $35 when the booking itself is four
or more Saturdays in a row, $30 only for a full season). Staff can "Add
dates" from the application page, withdraw an unpaid booking (Square link
cancelled, dates released, vendor emailed) and withdraw a whole application
(it goes to "Withdrawn"; the vendor comes back onto the list if they apply
again). Paid bookings stay locked; refunds happen in Square. Same day:
vendors get a personal "book more dates" link in their payment-received
and booking-withdrawn emails; they pick open Saturdays and staff confirm the
request with one click (dates booked, Square request created, payment link
emailed) or decline it with a note. Staff record the certificate of
insurance's expiry date when approving it; Saturdays after that cannot be
booked by anyone until a renewed certificate is approved. A vendor who
sends in a new application after being approved goes back on the list as
"Updated · needs review" and must be approved again before new dates.

## Before handing to the client's market manager

1. Invite the client's manager from `/staff` (they choose their own
   password), and switch reply-to and staff notifications to the client's
   mailbox. Decide who keeps the owner login.
2. Refund the $40 test payment in Square (Nathan).
3. Decide on the seven test applications: leave them (all named as tests) or
   approve a one-off database cleanup to remove them. Approved applications
   cannot be declined through the app.
4. Rotate the Neon database password and update `DATABASE_URL` in Vercel.
5. Confirm season settings: season 2026-2027, 55 vendor booths plus 4 food
   truck spaces per date, the Saturday date list, $40 per booth per date.
6. Client confirms the payout bank in Square.
7. Move Vercel from Hobby to Pro (Hobby is for non-commercial use).
8. Turn off old HighLevel workflows and delete HighLevel test contacts.
9. Hand over: sign-in address, `docs/CHANGES-2026-09-10.md` (architecture),
   `docs/vendor-emails.md` (every email and its trigger).

## Next work, in order

1. **HighLevel applicants**: 21 vendors were emailed a personal pre-filled
   application link on Sept 11. None had signed the agreement or supplied
   insurance in HighLevel, so they finish on the new site and then flow
   through approval, dates and payment like everyone else. Watch the
   applications list for them; re-send from the invitation endpoint if needed.
2. **"Add a vendor" staff screen** for walk-ups and phone applications.

## Later improvements

- A staff list of open date requests across all vendors (today each shows
  on its vendor's application page and in the staff email).
- Insurance expiry reminders to vendors before their certificate lapses.
- More vendor emails: document decision, hold expired, market-day reminder,
  booth assignment and Vendor Pass (the payment email promises these).
- "Payment received" on the return-from-Square page without a session.
- Retire the old booth-map dashboard (reads demo tables).
- Re-add "Text Us" once A2P approval arrives.
- Remove dormant HighLevel code once the client confirms it is gone for good.
