# Fresh Air Markets & Events — Booth Rental SaaS for Farmers Markets

A multi-tenant Next.js SaaS. Market operators sign up, get a license and a
seeded market map instantly, and manage everything from a password-protected
dashboard. Vendors book off a public, per-market visual map.

## Features

**Marketing site (`/`)**
- Sharp sales landing page: hero with a *live* embedded product demo (the
  real demo market, fetched from the API), feature grid, "how it works",
  pricing tiers, FAQ, and CTAs into `/signup`.

**Accounts & licensing**
- `/signup` creates an account, generates a license key (`FAM-XXXX-XXXX-XXXX`),
  starts a 14-day trial on the chosen plan (Starter / Pro / Season Pass), and
  seeds a brand-new market map — all in one request.
- `/login` is the only way into the dashboard. Passwords are hashed with
  scrypt; sessions are signed, HttpOnly cookies.
- Every account is fully isolated: its own booths, bookings, and public
  booking page at `/m/<slug>`. Cross-tenant access is rejected (404) at the
  API layer, not just hidden in the UI.

**Dashboard (`/dashboard`, password-protected)**
- Shows the operator's market name, plan, license key, trial countdown, and
  a copyable link to their public booking page.
- **Verification board**: approve or decline inquiries. Approval is atomic
  and enforces *one vendor per booth per market day* — conflicting
  approvals are rejected with the exact conflicting dates and vendor.
- **Map editor**: drag booths to rearrange the market, click to edit
  label/zone/price, add and remove booths.
- Rented booths show the vendor's business name and category on the map.
- Stats: pending inquiries, vendors per weekend, occupancy %, booked revenue.

**Public market page (`/m/<slug>`)**
- Interactive SVG market map (big U layout + center island) with live
  availability per weekend — available / partly booked / rented.
- Click a booth → see zone + price per day → pick one weekend or many
  (Fri/Sat/Sun market days) → live total → send a rental inquiry.
- Booth requests for already-rented dates are blocked server-side.

**GoHighLevel integration**
- Operator signups tag the contact `bhq-signup` + `bhq-plan-<plan>` — feed
  your sales/onboarding automations.
- Every vendor lifecycle event upserts a GHL contact and tags it:
  `booth-inquiry`, `booth-approved`, `booth-rejected`, plus `category-*`.
- A note with booth, dates, and total is added to the vendor's contact.
- Not configured? Events are logged and skipped; the app works fine.

## Running

```bash
npm install
npm run dev
```

With no `DATABASE_URL` the app runs in **demo mode**: an in-memory store
seeded with one live demo tenant (see below) plus whatever accounts you
create in the session. Data resets on restart — perfect for previews.

### Demo login

The marketing site's "live demo" links to `/m/sunrise-market` (public, no
login). To see the dashboard behind it, sign in at `/login` with:

- Email: `demo@freshairmarkets.app`
- Password: `sunrise-demo`

(Also available as a "Fill in the live demo login" button on the login page.)

## Environment variables

See `.env.example`. Summary:

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | Postgres (Neon) connection string. Schema auto-creates, migrates, and seeds the demo tenant on first request. | unset → demo mode |
| `AUTH_SECRET` | Signs session cookies. A private value is required in production; the public demo key is rejected. | dev fallback only |
| `GHL_API_TOKEN` | GHL Private Integration token (scopes: contacts.write, contacts.readonly) | unset → GHL skipped |
| `GHL_LOCATION_ID` | GHL location (sub-account) id | unset → GHL skipped |

## Deploying on Vercel

1. Import the repo in Vercel and set **Root Directory** to `fresh-air-markets/`.
2. (Optional but recommended) Storage → Create Database → **Neon Postgres**;
   Vercel injects `DATABASE_URL` automatically. Base booking tables seed on
   first request, while reviewed integration migrations are applied separately.
3. Set `AUTH_SECRET` and your `GHL_API_TOKEN` + `GHL_LOCATION_ID` env vars.
4. Deploy.

For the Fresh Air L06–L08 workflows, follow the exact migration, private
environment-variable, HighLevel event-mapping and QA evidence steps in
[`docs/l06-l08-deployment-qa-runbook.md`](docs/l06-l08-deployment-qa-runbook.md).

## Architecture

- **Next.js 15** App Router + TypeScript + Tailwind CSS 4.
- The map is a hand-rolled SVG component (`src/components/MarketMap.tsx`)
  shared by the public booking page and the dashboard (pointer-event
  dragging in the dashboard).
- Storage is behind a small interface (`src/lib/store.ts`) with two
  backends: in-memory demo (`store-memory.ts`) and Postgres via
  `postgres.js` (`store-pg.ts`) — no ORM, schema bootstraps itself. Every
  method is scoped by `marketId` (an account's id), which is how tenants
  stay isolated.
- Auth (`src/lib/auth.ts`): scrypt password hashing, HMAC-signed session
  cookies carrying the account id.
- Licensing (`src/lib/plans.ts`): plan catalog, license key generation,
  trial-window math.
- GHL client lives in `src/lib/ghl.ts` (LeadConnector API v2).
