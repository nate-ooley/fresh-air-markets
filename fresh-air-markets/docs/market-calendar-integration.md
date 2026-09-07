# Fresh Air calendar integration

Set the private server-side FAME_MARKET_ACCOUNT_ID to the existing portal account ID and FAME_SEASON_ID to 2026-2027. These are the same identity settings used for application handoff. Do not use the HighLevel location ID as a portal account ID or create a replacement contact/account just to satisfy configuration.

The public market page, manager dashboard, public availability API, inquiry validation and admin overview now share src/lib/market-calendar.ts. The configured account uses the confirmed 35 Saturdays, October 3, 2026 through May 29, 2027. Other accounts retain their existing calendar. A configured Fresh Air account with an unsupported/missing season has no bookable dates, instead of falling back to demo weekends.

Public pages and writes exclude dates before the current date in America/New_York. Admin review includes all 35 season dates so historical bookings remain visible. This uses a calendar-day cutoff; market-hour submission cutoffs and mid-season Full Season pricing still require business verification. Historical inquiry/application records are not rewritten.

Vendor and admin map controls provide a labeled date selector containing every supplied date; the previous five/six-week display truncation is removed. No dates produces a disabled selector with explanatory text.

Five automated component cases cover all 35 Saturdays and immutable values, exact market/season scoping, New York date boundaries and historical admin access, real availability/admin handlers, and real inquiry acceptance/rejection with no writes or CRM sync for invalid dates. Route tests use isolated store/CRM/limiter doubles. Browser interaction, deployed configuration, source-form alignment and production database/calendar persistence remain unverified.

This change connects calendar selection and validation. It does not complete final booth quantity, Fresh Air $30/$35/$40 pricing, category limits or CHECK/RESERVE integration. The legacy booth inquiry price calculation remains separate; do not enable this as the production final-reservation system until those launch tasks are complete. Full Season must ultimately expand to the canonical set and price through the final quote flow, not infer the discount from an arbitrary set of dates.
