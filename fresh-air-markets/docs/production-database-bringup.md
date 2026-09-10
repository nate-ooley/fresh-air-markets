# Production database bring-up

This is the release procedure for connecting the Fresh Air portal to a real
Production PostgreSQL (Neon) database. It is separate from the Preview/QA
procedure in [`database-readiness.md`](database-readiness.md). Nothing here
touches HighLevel, Square or email; those stay disabled until their own
runbooks are complete.

## What is true today (10 September 2026)

- The Vercel project `farmers-market` has **no database in Production**. Only
  `AUTH_SECRET` is set there. The Neon resource `neon-green-car` is connected
  to **Preview only**. Production therefore runs the in-memory demo store and
  forgets every account and booking on each cold start.
- Production serves the `main` branch (commit `5d27887`, "First Stage"). PR #1
  (`codex/vendor-booking-validation`) must be merged before any of the
  application, reservation or payment routes exist in Production.
- Without migrations 001–021, the public vendor inquiry endpoint answers 503
  because the persistent rate limiter table (migration 002) is missing, and
  every application/reservation/payment route answers 503.

## Prerequisites

1. Merge PR #1 to `main` (or deploy the reviewed branch to Production).
2. A private `AUTH_SECRET` of **at least 32 characters** in Production. Shorter
   values now fail sign-in with 503 instead of signing cookies with a weak key.
3. Node 22 and the Vercel CLI signed in as the project owner.

## 1. Connect Neon to Production

In Vercel: Storage → `neon-green-car` → **Connect Project** → environment
**Production**. Neon creates the production branch and injects `DATABASE_URL`,
`DATABASE_URL_UNPOOLED` and the `DATABASE_*` siblings into Production. Record
the direct (non-pooler) endpoint hostname from the Neon dashboard, for example
`ep-example.us-east-2.aws.neon.tech`. The hostname is an identifier, not a
secret.

Also set in Production: `FAME_SEASON_ID=2026-2027` and `FAME_BOOTH_CAPACITY`
(the approved market-wide capacity, a positive integer up to 9999).

## 2. Inject the Production variables locally

Every command below reads the injected process environment and refuses to run
unless `VERCEL_ENV=production`. Never paste connection strings into a shell
history, ticket or chat.

```sh
cd fresh-air-markets
vercel env pull .env.production.local --environment=production --yes
set -a; . ./.env.production.local; set +a
export VERCEL_ENV=production
```

If a value is marked *Sensitive* in Vercel it cannot be pulled; temporarily
enter it into the shell from the Neon dashboard instead, then clear the shell.

## 3. Create the Fresh Air manager account

The base tables are created by this command when the schema is empty, or
adopted when the deployed app already created them. Public signup is closed,
so this is the only supported way to create the manager login.

```sh
FAME_CREDENTIALS_DIR=$(mktemp -d /private/tmp/fame-production-credentials.XXXXXX)
node scripts/bootstrap-qa-account.mjs create-production-manager --production \
  --expected-host=YOUR_PRODUCTION_NEON_HOST \
  --email=OWNER_EMAIL --slug=fresh-air-markets \
  --market-name="Fresh Air Markets & Events" \
  --credentials-file="$FAME_CREDENTIALS_DIR/manager.json"
```

- The generated password is written only to the mode-0600 credential file.
  Keep that file private; a retry with the same file verifies the account and
  never resets the password or creates a second account.
- The output contains `FAME_MARKET_ACCOUNT_ID`. Set it in Production.
- If the output says `demoAccountPresent: true`, the deployed app was reached
  before this change and seeded the public demo login. Remove it:

  ```sh
  node scripts/bootstrap-qa-account.mjs remove-demo-tenant --production \
    --expected-host=YOUR_PRODUCTION_NEON_HOST
  ```

  This deletes only the recognized demo account, its booths, bookings, dates
  and inquiry receipts. It refuses anything that is not the exact demo identity.

## 4. Apply migrations 001–021

```sh
node scripts/database-readiness.mjs plan
node scripts/database-readiness.mjs check --production --expected-host=YOUR_PRODUCTION_NEON_HOST
node scripts/database-readiness.mjs apply --production --expected-host=YOUR_PRODUCTION_NEON_HOST
node scripts/database-readiness.mjs check --production --expected-host=YOUR_PRODUCTION_NEON_HOST
```

The final `check` must print `"ready": true` and exit 0. In `--production`
mode the check additionally lists `demo_account_present` as a blocker while
the public demo tenant exists. A failure prints only a fixed error code, the
SQLSTATE (`pgCode`) and the failing migration file name; nothing from the
connection string or rows is ever printed.

## 5. Redeploy and verify

Redeploy Production so the new variables are in effect, then:

1. Sign in at `/login` with the manager email and the password from the
   credential file. The demo login must be rejected.
2. Confirm `/applications` loads (empty list) and `/api/admin/applications`
   answers 200.
3. Confirm `/api/m/<slug>/booths?dates=<open market day>` answers 200 for the
   manager's slug and 404 for `sunrise-market`.
4. Keep `GHL_PAYMENT_SYNC_ENABLED`, `GHL_PAYMENT_EMAIL_ENABLED`,
   `SQUARE_ALLOW_LIVE_PAYMENTS` and the GitHub scheduler variable off until
   their runbooks are complete.

## Clean up

```sh
rm -f .env.production.local
```

Leave the credential file in its private directory only as long as the owner
needs it to sign in, then store the password in the team password manager and
delete the directory.
