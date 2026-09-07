# L06–L08 deployment and QA runbook

This runbook turns the exact-record code in PR #1 into a controlled QA
integration. It covers application approval (L06), agreement completion (L07)
and insurance upload/review (L08). Square, reservations, SMS, and production
contacts are outside this run.

## 1. Prepare a QA deployment

Use the Farmers Market Vercel project and a database that is safe for the two
approved QA vendors only:

- `lnooley@gmail.com`
- `nate@autocraftstudios.com`

Set the following server-side variables in the QA deployment. Keep every
secret out of HighLevel form fields, AI Studio browser code, links, and this
repository.

| Variable | Required for |
| --- | --- |
| `DATABASE_URL` | L06, L07, L08 persistent state |
| `AUTH_SECRET` | signed manager sessions |
| `GHL_LOCATION_ID` | all HighLevel source validation |
| `FAME_MARKET_ACCOUNT_ID` | portal `accounts.id` for Fresh Air, not the HighLevel location ID |
| `FAME_SEASON_ID=2026-2027` | all exact-record mappings |
| `GHL_APPLICATION_WEBHOOK_SECRET` | L06 application intake event |
| `GHL_API_TOKEN` with `opportunities.readonly` + `opportunities.write` | L06/L07 exact HighLevel opportunity updates |
| `GHL_APPLICATION_PIPELINE_ID` and the four L06 stage IDs | L06 exact review-stage mapping |
| `CRON_SECRET` | L06 authenticated retry scheduler |
| `GHL_AGREEMENT_WEBHOOK_SECRET` | L07 agreement issued/completed events |
| `GHL_AGREEMENT_TEMPLATE_ID` | L07 approved template gate |
| `GHL_AGREEMENT_NOTIFICATION_EMAIL=nate@autocraftstudios.com` | QA-only L07 notice destination |
| `GHL_AGREEMENT_PIPELINE_ID`, sent and completed stage IDs | L07 exact signed-agreement stage mapping |
| `DOCUMENT_INGRESS_WEBHOOK_SECRET` | L08 private-transfer intake |
| `DOCUMENT_SCANNER_WEBHOOK_SECRET` | L08 scanner callback |

The preview is a build check only until these variables and the migrations
exist. A route returning `503` for missing persistent storage is expected in
an unconfigured preview and is not a QA pass.

## 2. Apply the portal migrations

The portal store bootstraps its original booking tables, but it does **not**
apply L06–L08 migrations automatically. Apply these files in order to the
reviewed QA database:

1. `docs/migrations/001-application-handoff.sql`
2. `docs/migrations/004-application-review-outbox.sql`
3. `docs/migrations/005-agreement-completion-outbox.sql`
4. `docs/migrations/006-application-document-ledger.sql`
5. `docs/migrations/007-agreement-completion-stage-outbox.sql`
6. `docs/migrations/008-application-opportunity-identity.sql`
7. `docs/migrations/009-agreement-stage-terminal-state.sql`
8. `docs/migrations/010-application-review-terminal-state.sql`

For a PostgreSQL command-line session pointed at the reviewed QA database:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/migrations/001-application-handoff.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/migrations/004-application-review-outbox.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/migrations/005-agreement-completion-outbox.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/migrations/006-application-document-ledger.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/migrations/007-agreement-completion-stage-outbox.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/migrations/008-application-opportunity-identity.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/migrations/009-agreement-stage-terminal-state.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/migrations/010-application-review-terminal-state.sql
```

Record the database target, migration timestamp and commit SHA in the Asana
launch grid. The successful CI PostgreSQL suite proves the migration sequence
on a disposable database; it does not prove the deployed database.

## 3. Configure HighLevel server-side events

Keep every workflow draft until its endpoint returns a successful QA response.
Never place the bearer secret in a public form or browser action.

### L06: application intake and exact manager review

After a QA form creates/updates a contact and exact opportunity, make a
server-side call to:

`POST /api/integrations/highlevel/applications`

Use `Authorization: Bearer <GHL_APPLICATION_WEBHOOK_SECRET>` and include a
stable source event ID, existing contact ID, exact opportunity ID, configured
location ID, season and source snapshot. The endpoint creates or replays one
portal application; it does not create a HighLevel contact, send mail, or make
an approval decision.

The manager must load and submit the exact portal review route:

`GET` / `PATCH /api/admin/applications/:applicationId/review`

The session, path application ID, newest source event and idempotency key bind
the decision. After it commits, the portal immediately attempts only that new
outbox item. The worker reads the immutable opportunity and verifies its
contact, pipeline and stage before it updates the configured stage; it reads
the opportunity again before recording delivery. This prevents a retry from
triggering a second workflow. Configure an authenticated scheduler to call
`GET /api/internal/cron/application-review-outbox` with
`Authorization: Bearer <CRON_SECRET>` for recovery of transient provider
failures. Do not configure a cron cadence until the Vercel plan supports it.

### L07: agreement issued and completed

After HighLevel issues the approved QA agreement, call:

`POST /api/integrations/highlevel/agreements/issued`

After a genuine completed signing event, call:

`POST /api/integrations/highlevel/agreements/completed`

Both calls use `Authorization: Bearer <GHL_AGREEMENT_WEBHOOK_SECRET>` and
must contain the real event, document, template, contact and opportunity IDs.
The completed route accepts only a document that was first bound through the
issued route. On a captured completion, it immediately attempts an exact
opportunity-stage update using the completed document's immutable opportunity
ID. The worker verifies contact, pipeline, location and the configured
agreement-sent stage before moving it to the configured completed stage; a
retry already at the completed stage is a no-op. Use
`GET /api/internal/cron/agreement-completion-stage-outbox` with
`Authorization: Bearer <CRON_SECRET>` for recovery. Configure the QA-only
notification recipient before any genuine signature. Do not conduct a real
signing while the global signed-document alert can notify a live admin.

### L08: private document transfer and scanning

The public HighLevel form is not the document ledger. A private transfer
worker must stream a submitted file to private object storage, calculate its
actual byte count and SHA-256, inspect bounded first/last samples, and call:

`POST /api/integrations/documents`

with `Authorization: Bearer <DOCUMENT_INGRESS_WEBHOOK_SECRET>`. It must pass
the exact internal portal application ID and never submit a public file URL.
Only PDF, PNG and JPEG files up to 10 MiB are accepted when extension, MIME,
signature, byte count and samples agree.

The scanner reports the exact stored version through:

`POST /api/integrations/documents/:documentId/scan`

with `Authorization: Bearer <DOCUMENT_SCANNER_WEBHOOK_SECRET>`. A manager can
then use `PATCH /api/admin/documents/:documentId/review` with a session and
idempotency key. The worker, scanner and downstream delivery mapping must be
configured before publishing the QA form. The existing production form's
public file access is not a replacement for private storage.

## 4. Run the green-evidence cases

Capture the QA record/application/document IDs, before-and-after state,
workflow log, exact message/document ID, recipient evidence, and duplicate
count for every case. Keep all sends limited to the two QA addresses.

| L06 approval | L07 agreement | L08 insurance |
| --- | --- | --- |
| Exact current application approves once | Correct issued document completes once | Valid PDF, PNG and JPEG capture as Submitted only |
| Simultaneous/retry decision recovers once | Incomplete/declined never completes | Unsupported, corrupt, empty and size-boundary files reject |
| Invalid/expired/unknown identity stops | Duplicate/concurrent completion yields one receipt | Second QA vendor maps to its own application |
| Older/current/declined/cancelled record isolation | Wrong/superseded template/contact/document stops | Correction and resubmission retain version history |
| Signed-out/tampered approval has no mutation | Before/after insurance yields at most one next action | Replay/cross-record/stale version cannot approve wrong file |

An actual document signature needs fresh confirmation at the signature action.
The public browser policy must be restored before public signing or upload
evidence is claimed; it must not be bypassed.

## 5. Change task status only with proof

Keep L06, L07 and L08 red until all five cases in their column are recorded in
the correct Asana grid. CI green, workflow test mode, a provider-accepted
email, or a simulated document event can support a case but cannot replace the
listed end-to-end proof.
