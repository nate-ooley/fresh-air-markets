# QA database migration and readiness

The Preview portal has connected to Neon successfully: its public booth API,
manager login and authenticated dashboard were previously verified. Those checks
initialize only the base portal tables. They do **not** apply the application,
agreement, document, reservation, or Square ledgers in migrations 001–017.

The checked-in runner closes that deployment gap without creating a public
administration endpoint. It sends no email, SMS, HighLevel request or Square
request, creates no applicants, and does not seed or rename a market account.
This runner is restricted to a reviewed **Preview / QA Neon target**. It is not a
production release procedure.

## Run after restoring private Preview environment access

1. Authenticate the Vercel CLI or use the approved secret-injection mechanism
   for the `farmers-market` project. Inject its **Preview** variables for branch
   `codex/vendor-booking-validation`. Never paste connection strings into chat,
   commit them, or copy the Production variables into this test session.
2. In Neon, confirm the selected branch contains QA data only. Record its
   endpoint hostname, such as `ep-example.us-east-2.aws.neon.tech`. The hostname
   is an identifier, not the database password. A checkbox or variable saying
   Preview does not prove the underlying database is separate from Production.
3. Run the offline plan. This prints only migration filenames and SHA-256
   checksums and does not connect:

   ```sh
   node scripts/database-readiness.mjs plan
   ```

4. With the private Preview variables injected, replace `YOUR_QA_NEON_HOST` below
   with the verified endpoint hostname. Run the read-only check first:

   ```sh
   node scripts/database-readiness.mjs check --qa --expected-host=YOUR_QA_NEON_HOST
   ```

5. Apply the reviewed sequence to that same QA target:

   ```sh
   node scripts/database-readiness.mjs apply --qa --expected-host=YOUR_QA_NEON_HOST
   ```

6. Run the check again. Save its JSON result and the deployed commit in the
   Linear database task. Asana carries only the top-level status.

The runner requires `VERCEL_ENV=preview` in the injected process and a valid
Neon PostgreSQL URL with TLS (`sslmode=require`). It prefers
`DATABASE_URL_UNPOOLED` when supplied, but rejects it if its endpoint, database
name or user differs from `DATABASE_URL`. The host pin allows Neon’s matching
pooled/unpooled host variants. No new secret has to be created for the runner.

## What the runner verifies

- All fifteen numbered migrations are present in order.
- The portal's base `accounts`, `booths`, `bookings` and `booking_dates` tables
  exist before migration. Missing base tables stop the migration; the runner
  will not fabricate an account or seed production-like application records.
- A transaction-scoped advisory lock serializes concurrent runners. All pending
  migration files and their checksummed history commit together; failure rolls
  back that run. Lock and statement timeouts prevent indefinite execution.
- Repeated runs skip unchanged, recorded migrations. A changed checksum,
  unexpected historical version or gap stops execution. Do not edit migration
  history to make a failed check pass.
- Expected tables, valid indexes and enabled business-rule triggers are present.
  A disabled opportunity identity guard is a failure even when migration
  history says the migration ran.
- `FAME_MARKET_ACCOUNT_ID` names an existing account other than `demo-market`,
  `FAME_SEASON_ID` is `2026-2027`, and `FAME_BOOTH_CAPACITY` is a positive integer
  accepted by the reservation configuration.

The object check verifies required objects and the reviewed migration history;
it is not a byte-for-byte audit of every column, function body and constraint
against arbitrary manual database edits. Workflow acceptance tests must still
exercise their actual behavior.

The migration files are data-preserving upgrades, not a database reset.
Migrations 014–015 deliberately quarantine legacy payment records that lack
Square cancellation proof and schedule existing pending retirement work. These
are reviewed record updates; the runner does not erase the history or call
Square. Pause QA writers while upgrading an older partial schema.

## Interpreting the result

- Exit **0**, `ready: true`: recorded schema objects/history and account
  configuration checks passed. Continue with deployed workflow tests.
- Exit **2**, `ready: false`: connection worked but listed readiness blockers
  remain. For `apply`, the migrations may have committed successfully while the
  separate account/season/capacity check remains red. Inspect `migrations.applied`
  and `blockers`; do not repeatedly create databases.
- Exit **1**: target validation, migration integrity or database operation
  failed. Unexpected database errors are deliberately reduced to
  `database_operation_failed` so SQL/provider messages cannot expose credentials
  or applicant rows. Inspect the private Neon logs when further detail is needed.

A database manually migrated before this runner has no checksummed history yet.
The first runner invocation reapplies the idempotent, reviewed sequence and
records its checksums. It never guesses which draft was applied from table names.
A prior incompatible draft can therefore fail and roll back; investigate it
rather than resetting the database.

## Remaining external steps for a green database task

- Authenticate access to the exact Vercel Preview / QA Neon target and run this
  tool privately. Local tests are not proof that the hosted migration ran.
- Verify the actual Fresh Air QA manager account and set its exact account ID,
  season and reviewed capacity. Do not point the mapping at the demo tenant.
- Verify one controlled application against the correct HighLevel location
  `aooAnUXF0COePorBo7wL`, with no live contact/admin messages and no duplicate
  imports of existing applicants.
- Repeat the protected deployed tests for application capture, review,
  agreement, private uploads, reservation and Square Sandbox. Confirm each
  expected ledger and provider outcome. Migration readiness alone is not proof
  that any email was delivered or payment was processed.

Production still requires a separately reviewed database target, release and
payment implementation. Payments must begin from
`freshairmarketsandevents.com`; a successful QA migration does not change that
routing or authorize live collection.

## Regression coverage

`tests/database-readiness.test.cjs` verifies target validation, transaction
wrapper handling, all fifteen migration files, checksum/order enforcement and
redaction of invalid connection values. These five tests pass locally.

`tests/database-readiness.pg.test.cjs` runs only with `DATABASE_TEST_URL` pointing
to the disposable local database `fresh_air_test`. Its five database scenarios
cover read-only inspection, full application/repeat with existing-row
preservation, rollback on a mid-sequence failure, concurrent runners, and
readiness failures for a disabled guard or incorrect account/season. The suite
must pass in PostgreSQL CI before treating the runner as verified.
