# QA database migration and readiness

Historical Preview checks reached a public booth API, manager login and
dashboard. They do not establish readiness of a newly provisioned Neon branch.
The regular portal initializer creates only the base tables and can seed a demo
account; do not use a public demo request to bootstrap the Fresh Air QA tenant.
The application, agreement, document, reservation and Square ledgers require
migrations 001–024.

## September 9 hosted inspection

The signed-in Vercel browser can now access `farmers-market` and its existing
Neon resource `neon-green-car` (`blue-leaf-02724804`). The connection is Preview
only, with automatic Preview database branching enabled. The variable list
contains one Neon-linked `DATABASE_URL` and one `DATABASE_URL_UNPOOLED`, both
Secret / Preview. No duplicate connection or visible manual placeholder remains.

The resource's read-only Query console returned `neondb` / `public` and **zero
public tables**. This describes the resource-console target, not every deployment
branch. Deployment `dpl_758fkmxPxWxJBy4erfyq5v3hX8Ne` at commit `abdd607` records
Neon branch `br-divine-breeze-awf9vfo1` in its provisioning action. Its endpoint
and schema still need inspection in Neon; the console currently requires the
owner's email activation. No hosted schema or account was changed.

The September 10 read-only inspection of that exact Preview branch found the
legacy five-table schema and the known Sunrise demo tenant, rather than an empty
schema. The inspected bookings had the known `.example` vendor identities and
there were no inquiry receipts. This does not turn the demo into the Fresh Air
account. The separate seeded-QA procedure below preserves those records and
still requires exact schema and data validation at execution time.

The immutable Preview entry page renders the vendor application entry point and
private staff sign-in. Its `/apply` handoff reaches the market's `/vendors` page.
These are navigation checks, not authenticated/database/workflow acceptance.

The checked-in runner closes that deployment gap without creating a public
administration endpoint. It sends no email, SMS, HighLevel request or Square
request, creates no applicants, and does not seed or rename a market account.
With `--qa` this runner targets a reviewed **Preview / QA Neon target**. The
separate `--production` mode, the production manager account command and the
demo-tenant removal are documented in
[`production-database-bringup.md`](production-database-bringup.md); they
require `VERCEL_ENV=production` and refuse Preview variables.

## Initialize an empty private QA branch

`scripts/bootstrap-qa-account.mjs` supplies the missing base-schema/private-manager
step without opening public signup or invoking the demo initializer. It is
separate from the migration runner below. Keep every outbound worker paused.
The owner must first verify the actual Neon branch and endpoint as QA-only.

Inject the real Preview variables privately. Bootstrap requires
`VERCEL_ENV=preview`, matching Neon URLs with TLS, `SQUARE_ENVIRONMENT=sandbox`,
`SQUARE_ALLOW_LIVE_PAYMENTS=false`, and outbound enable/routing flags unset or
`false`. Creation and account verification also require a private `AUTH_SECRET`
of at least 32 characters and `FAME_SEASON_ID=2026-2027`.

Inspect before writing, substituting the actual endpoint hostname:

```sh
node scripts/bootstrap-qa-account.mjs inspect --qa --expected-host=YOUR_QA_NEON_HOST
```

If the schema is empty and there is no existing private manager, create a new
mode-0700 directory outside the checkout for the generated login. For this
expressly isolated QA fixture, 30 spaces is the existing test-suite capacity;
it does not define the real market's capacity. Leave `FAME_MARKET_ACCOUNT_ID`
unset for the first creation and set `FAME_BOOTH_CAPACITY=30` or leave it unset
until the script returns the exact configuration suggestions.

```sh
FAME_QA_CREDENTIALS_DIR=$(mktemp -d /private/tmp/fame-qa-credentials.XXXXXX)
node scripts/bootstrap-qa-account.mjs create --qa \
  --expected-host=YOUR_QA_NEON_HOST \
  --email=nate@autocraftstudios.com --slug=qa-fresh-air \
  --qa-capacity=30 \
  --credentials-file="$FAME_QA_CREDENTIALS_DIR/manager.json"
```

Only an empty public schema can be initialized. Creation atomically adds the
four base tables and one private QA manager. It creates no demo tenant, booths,
bookings, applicants, payment records or outbound events. The QA slug/email
are checked against the target; existing data is never replaced. A competing
initializer causes a rollback. A retry with the same private file verifies the
exact account and password instead of creating another identity or resetting it.

The generated password stays in the private mode-0600 file, never stdout,
tickets or version control. Keep that file private for login and safe retry.
Do not put credentials in a command argument. The manager's legacy trial/license
fields exist only for model compatibility; no subscription or purchase occurs.

If a private QA account already exists, preserve it. After recording its actual
ID and authorized email, set `FAME_MARKET_ACCOUNT_ID` to that ID and run:

```sh
node scripts/bootstrap-qa-account.mjs verify-existing --qa \
  --expected-host=YOUR_QA_NEON_HOST \
  --account-id=YOUR_VERIFIED_QA_ACCOUNT_ID \
  --email=nate@autocraftstudios.com --qa-capacity=30
```

This is read-only and never resets a password. For either path, copy only the
returned non-secret account/season/capacity suggestions into Preview Config,
then apply all migrations below. Bootstrap success explicitly reports
`ready:false`; only the separate complete readiness check can pass schema and
configuration readiness. Production provisioning remains a separate task.

## Add a private QA account beside an unchanged legacy demo

Use this path only when the reviewed, isolated Preview branch was already
initialized by the legacy portal. Do not rename the demo account, repurpose its
password, delete its data, reopen public signup, or use the regular account
creation route. Ordinary `create` remains empty-schema-only.

The explicit `add-to-seeded-qa` command requires all the private Preview,
Sandbox/live-off, disabled-outbound, account, season, capacity and credential-file
guards above. First run this read-only inspection with the actual endpoint:

```sh
node scripts/bootstrap-qa-account.mjs inspect-seeded-qa --qa \
  --expected-host=YOUR_QA_NEON_HOST
```

The inspection accepts only the compatible `accounts`, `booths`, `bookings`,
`booking_dates`, and `inquiry_requests` tables with their reviewed built-in
column types, required constraints and valid indexes. Unexpected tables,
functions, rules, triggers, row-security policies, inheritance, expression
indexes, or incompatible columns/constraints stop the procedure.

The only preexisting account must match the known Sunrise demo identity and
its public demo password. Any booths and bookings must match the application's
known demo records, including ownership, vendor identities, dates and amounts.
Dates are recognized from their original creation day, including partial
weekends; no fixed sample counts or current dates are assumed. Subsets of the
known seed are permitted, but extra tenants, real vendor details, modified demo
records, orphaned dates, and any inquiry receipts are refused. The inspection
prints aggregate counts only and never returns passwords or applicant rows.

After a successful inspection, leave `FAME_MARKET_ACCOUNT_ID` unset for first
creation and use a fresh mode-0700 directory outside the checkout:

```sh
FAME_QA_CREDENTIALS_DIR=$(mktemp -d /private/tmp/fame-qa-credentials.XXXXXX)
node scripts/bootstrap-qa-account.mjs add-to-seeded-qa --qa \
  --expected-host=YOUR_QA_NEON_HOST \
  --email=nate@autocraftstudios.com --slug=qa-fresh-air \
  --qa-capacity=30 \
  --credentials-file="$FAME_QA_CREDENTIALS_DIR/manager.json"
```

The command checks eligibility before generating a credential. Inside the
transaction it holds the same migration advisory lock and table locks, rechecks
the schema and every existing record, then inserts exactly one private QA
account. It creates no booths, bookings, application records or outbound events
and never changes any existing row. A conflict or failure rolls back the insert.
Keep ordinary QA writers paused during setup.

Reuse the same private credential file for a retry. If its exact account already
exists, the command verifies that identity and password without resetting it or
adding another account, including after migrations have run. A different file
cannot add a second QA tenant to the already initialized branch. If the private
file is unavailable but the exact QA identity is known, use `verify-existing`;
do not create a replacement credential or modify the account to make setup pass.

Set only the returned nonsecret account ID/season/capacity suggestions in Preview
and apply all migrations below. Both inspection and creation return
`ready:false`: migration readiness, private manager login, hosted workflows,
and Square Sandbox acceptance remain separate checks. A schema/data rejection
requires investigation of the private target, not deletion or a force option.

## Apply migrations using private Preview environment access

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

- All twenty-four numbered migrations are present in order.
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
  history says the migration ran. Payment Pending and paid-stage sync each
  require their outbox table, enqueue trigger and eligibility view; a disabled
  enqueue trigger or missing view blocks readiness.
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
wrapper handling, all twenty-four migration files, checksum/order enforcement and
redaction of invalid connection values. These five tests pass locally.

`tests/database-readiness.pg.test.cjs` runs only with `DATABASE_TEST_URL` pointing
to the disposable local database `fresh_air_test`. Its six database scenarios
cover read-only inspection, full application/repeat with existing-row
preservation, rollback on a mid-sequence failure, concurrent runners, and
readiness failures for a disabled guard or incorrect account/season, and disabled
payment enqueue triggers or missing eligibility views. The suite
must pass in PostgreSQL CI before treating the runner as verified.

The seeded-QA tests compare the recognizer against the actual portal fixtures,
including varied creation weekdays and refusal of real applicant changes.
`tests/pg/qa-seeded-bootstrap.test.cjs` covers read-only inspection, preservation
of every original row, private-password verification, concurrent/repeated runs,
conflicting identities, incompatible schemas and SQL hooks, rollback, and the
complete 001–024 migration sequence beside the preserved demo. Run this suite
against the disposable local PostgreSQL CI service before using the command on
the hosted Preview branch; isolated tests do not establish hosted readiness.
