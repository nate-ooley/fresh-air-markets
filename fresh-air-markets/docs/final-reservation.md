# Final application reservation

`POST /api/admin/applications/:id/reserve` is the final server-side
CHECK→RESERVE boundary. It is an authenticated manager action for one existing
portal application. It creates no email, SMS, HighLevel update, Square order,
or payment link. A separate manager checkout action may use a paid reservation
only after this transaction has committed.

## Required private configuration

Set these server-only values for the Fresh Air account:

| Value | Meaning |
| --- | --- |
| `DATABASE_URL` | Reviewed portal database. |
| `FAME_MARKET_ACCOUNT_ID` | Existing portal `accounts.id`, never the HighLevel location ID. |
| `FAME_SEASON_ID=2026-2027` | The confirmed Fresh Air season. |
| `FAME_BOOTH_CAPACITY` | The approved market-wide booth capacity, as a whole number. There is no fallback. |

The implementation deliberately refuses a missing, zero, fractional, or
cross-market capacity setting. The capacity was not specified in the source
requirements, so it is never inferred from a legacy booking or map.

## Database order

Apply the reviewed portal migrations in this order: `001`, `004`, `005`,
`006`, `007`, `008`, `009`, `010`, `011`, `012`, then
[`013-final-reservation-writer.sql`](./migrations/013-final-reservation-writer.sql).
Migration `013` adds immutable finalization evidence and one date allocation
per reserved market date. The Square checkout query requires that evidence, so
it safely rejects manually seeded and legacy booking rows.

## Manager request

The signed-in market session and `:id` path bind the account and application.
Supply an `Idempotency-Key` UUID v4 header and this exact JSON shape:

```json
{
  "applicantType": "Vendor",
  "vendorCategory": "Arts & Crafts",
  "selectedDates": ["2026-10-03", "2026-10-10"],
  "fullSeason": false,
  "boothsPerMarket": 1,
  "foodLicenseRequired": false
}
```

`applicantType` and `foodLicenseRequired` are explicit manager final decisions:
the application handoff snapshots intentionally have no typed, authoritative
classification or license-waiver fields from which the portal could safely
infer them. They are authenticated, persisted in the immutable audit row with
the manager account, and never accepted from a vendor/public route.

`foodLicenseRequired` records Thomas’s final review decision. If it is `true`,
the current food-license document must already be validated and manager
approved. If it is `false`, no food-license document is accepted as a
substitute for insurance; the current insurance document must still be
approved.

Price, reservation ID, application ID, market, payment, provider, and redirect
fields are rejected. The route calculates all dates, rate, total, and payment
requirement from the canonical calendar and durable facts.

## Transaction rules

The writer locks the application identity, re-reads its latest source event,
then requires all of the following before inserting anything:

- an approved portal review whose source event is still the latest application
  event;
- a signed agreement for that exact application and market;
- a current validated and approved insurance document;
- a current validated and approved food-license document when Thomas marked it
  required;
- a valid exact season/date/quantity/category selection.

It derives the requested canonical dates first, locks capacity in sorted
market/date order, reads only existing immutable final-reservation allocations,
and re-runs the complete quote. It applies the $40 standard, $35 consecutive,
$30 full-season, Food Truck (four), nonprofit (one), and market-capacity rules
without accepting a browser amount. Any unavailable date rolls back the whole
request. Paid vendors start in `held`; nonprofits start in `confirmed` with a
zero total. Repeating the same application, selection, and idempotency key
returns the same reservation; a different selection conflicts.

The finalization records the exact source location/event, approved review event,
signed agreement, insurance document/version/review revision, and, where
required, food-license document/version/review revision. The finalization and
per-date allocation ledger rows are immutable. The base
reservation’s quote-bearing fields are also guarded after finalization, while
the later payment lifecycle may update only state and payment timestamps.
The database independently rechecks that evidence when it inserts the
finalization; a forged direct insert cannot use an unrelated or stale document,
source event, review, agreement, rate, or initial reservation state.

One application can have one immutable final reservation. A changed paid or
confirmed reservation must go through a separately reviewed change/release
flow; this endpoint returns a conflict rather than overwriting a hold or
silently reallocating capacity.

## Verification scope

`npm test` covers strict input binding, exact eligibility combinations,
preflight date derivation, quote selection, capacity configuration, authenticated
route outcome mapping, and no-payment route behavior. A deployed QA database
still needs migration and concurrency verification before a live workflow is
called green.
