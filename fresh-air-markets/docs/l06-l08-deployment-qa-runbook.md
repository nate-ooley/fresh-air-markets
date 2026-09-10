# L06–L08 deployment and QA runbook

Use this runbook for application review (L06), agreement completion (L07), and
insurance/food-license evidence (L08). It describes the current implementation,
including migration 021. It does not establish a hosted workflow pass or
production readiness. The five scenario groups for each workflow are in
[the QA matrix](l06-l08-qa-matrix.md).

## 1. Pin the QA environment and native mapping

Use the Farmers Market Vercel project, its protected Preview deployment, and a
verified separate QA Neon database. A Preview label alone does not prove that
the underlying database is isolated. Record the deployment commit and reviewed
database endpoint; preserve existing applicants and history.

Every test vendor and administrator message must go only to
`lnooley@gmail.com` or `nate@autocraftstudios.com`. Use Nate for the internal QA
recipient. No SMS, live-contact messages, or live-admin messages are permitted.
Inspect all downstream native triggers and recipients before setting the QA
routing flag or enabling workers. User-confirmed earlier form-email receipt is
partial evidence; it does not prove the current deployed integration.

The original application pipeline stays intact. L06 uses its existing Needs
Review, Approved, and Declined stages. `request_changes` remains Needs
Review/Open and makes no opportunity update or vendor-email call. Agreement and
payment progress use Opportunity custom fields on the same Approved/Open
opportunity; they do not use extra operational stages or a separate agreement
pipeline.

| Verified event | Exact native field | Expected value |
| --- | --- | --- |
| Bound agreement completed | Vendor Agreement Status | Signed |
| Eligible checkout committed | Vendor Payment Status | Ready for Payment |
| Exact provider email receipt proves sent/delivered | Vendor Payment Status | Payment Sent |
| Exact signed Square COMPLETED event reconciled | Vendor Payment Status | Paid |

Only the agreement row is a mutation tested by L07. The payment rows explain
the shared mapping and downstream boundary; payment acceptance needs its own
Sandbox tests. Production payment entry must start at
`https://freshairmarketsandevents.com`.

Use these server-side variables. Never put secrets in public forms, browser
code, URLs, tickets, or this repository.

| Variable | Type and purpose |
| --- | --- |
| `DATABASE_URL`; optional `DATABASE_URL_UNPOOLED` | Secret: verified QA Neon connection. Both must identify the same endpoint/database/user. |
| `AUTH_SECRET` | Secret: strong manager-session signing secret. |
| `GHL_API_TOKEN` | Secret: Fresh Air subaccount Private Integration token. L06/L07 and payment-field workers need `contacts.readonly`, `opportunities.readonly`, `opportunities.write`, and `locations/customFields.readonly`. Payment email also needs `conversations/message.write` and `conversations/message.readonly`. |
| `GHL_LOCATION_ID=aooAnUXF0COePorBo7wL` | Config: exact Fresh Air sub-account. |
| `FAME_MARKET_ACCOUNT_ID`; `FAME_SEASON_ID=2026-2027`; `FAME_BOOTH_CAPACITY` | Config: existing private portal account, confirmed season, and reviewed positive capacity. The account ID is not the HighLevel location ID or demo tenant. |
| `GHL_APPLICATION_PIPELINE_ID` | Config: actual Production pipeline ID, retained in Preview to prove it differs from QA. |
| `GHL_QA_APPLICATION_PIPELINE_ID` | Config, Preview only: one separate QA application pipeline shared by review, agreement, and payment delivery. |
| `GHL_APPLICATION_REVIEW_STAGE_ID`; `GHL_APPLICATION_APPROVED_STAGE_ID`; `GHL_APPLICATION_DECLINED_STAGE_ID` | Config: three distinct IDs from the selected pipeline's existing stages. No Changes Requested stage ID is required. |
| `GHL_AGREEMENT_STATUS_FIELD_ID`; `GHL_PAYMENT_STATUS_FIELD_ID` | Config: exact distinct Opportunity custom-field IDs. Workers verify location, model, name, options, and values; field labels are not IDs. |
| `GHL_PAYMENT_QA_ROUTING_VERIFIED=true` | Config, Preview only: set after native routing and recipient isolation are verified. A pipeline name alone is not proof. |
| `GHL_APPLICATION_WEBHOOK_SECRET` | Secret: authenticated L06 application capture. |
| `GHL_AGREEMENT_WEBHOOK_SECRET`; `GHL_AGREEMENT_TEMPLATE_ID` | Secret and Config respectively: authenticated issued/completed events and the one approved template. |
| `GHL_AGREEMENT_NOTIFICATION_EMAIL=nate@autocraftstudios.com` | Config: internal QA notification destination. Queuing an item does not prove a sender is connected. |
| `CRON_SECRET` | Secret: 32+ character authenticated recovery credential. |
| `DOCUMENT_INGRESS_WEBHOOK_SECRET`; `DOCUMENT_SCANNER_WEBHOOK_SECRET` | Secrets used by the current portal document implementation only. They do not establish that the native document bridge exists. |

Follow [Private Integration setup](highlevel-private-integration-setup.md) for
the exact permissions and owner handoff. Add `forms.readonly` for the planned
native document-submission reader; granting it alone does not connect that
reader or establish a document test pass. The implemented adapters send
`Version: v3`, matching the current official endpoint documentation. Do not
replace it with an old dated header copied from a generic token example.

`GHL_AGREEMENT_PIPELINE_ID` is an optional legacy alias only. If present, it
must equal the selected application pipeline. Do not configure agreement-sent,
agreement-completed, payment-pending, or payment-confirmed stage IDs for the
repaired field workers. Existing obsolete stages must not be deleted without
checking remaining native references.

Use Vercel's actual `VERCEL=1` and `VERCEL_ENV=preview` runtime. Production
configuration rejects nonempty `GHL_QA_*` and `GHL_PAYMENT_QA_*` controls.
Keep payment delivery flags disabled during this L06–L08-only run. Review and
agreement processing do not require Square credentials. A `503` from missing
configuration is a blocked test, not a pass.

## 2. Apply and verify the full QA schema

Follow [database readiness](database-readiness.md) for private injection of the
Preview variables. Pause old workers and QA writers during upgrade, especially
old stage-writing workers. Use the checked-in runner rather than applying only
the former L06–L08 subset:

```sh
node scripts/database-readiness.mjs plan
node scripts/database-readiness.mjs check --qa --expected-host=YOUR_QA_NEON_HOST
node scripts/database-readiness.mjs apply --qa --expected-host=YOUR_QA_NEON_HOST
node scripts/database-readiness.mjs check --qa --expected-host=YOUR_QA_NEON_HOST
```

Replace the host placeholder with the verified QA endpoint hostname; keep the
connection string private. The reviewed sequence is **all 21 numbered
migrations, 001–021**, including the inquiry, reservation, payment, and field
receipt migrations. Base portal tables and the actual private account must
already exist. The runner does not create a customer account or repair a
placeholder database URL.

Migration 021 requires `ghl_opportunity_fields_v1` receipts with exact native
identity and configured field/value evidence. It preserves legacy stage-receipt
history and fences/requeues eligible legacy work for verification. It does not
call HighLevel, fabricate successful field receipts, or silently revive failed
manual-review work. Never resume an old stage-writing worker after this upgrade.

Save the runner result and commit in the Linear evidence task. Asana receives
the top-level status only. A successful disposable PostgreSQL test or migration
check does not prove that a hosted workflow, email, or payment succeeded.

## 3. Wire and test L06 exact application review

After a QA form has captured its contact and exact opportunity, the native
server-side integration calls `POST /api/integrations/highlevel/applications`
with `Authorization: Bearer <GHL_APPLICATION_WEBHOOK_SECRET>`. Use a stable
event ID, exact contact/opportunity/location/season identities and a complete
source snapshot. This route captures or replays an application; it does not
create the contact, notify a vendor, or approve an application. Existing form
entrants need the same exact capture mapping without duplicate imports.

The signed-in manager reads and submits
`GET` / `PATCH /api/admin/applications/:applicationId/review`. The session,
application path, newest source event and idempotency key select the decision.
The durable review event/outbox commits before delivery is attempted.

- Approval and decline reconcile only the stored opportunity from Needs Review
  to the configured target. Exact contact/location/pipeline and Open status are
  verified; a retry already at the correct target is a read-only success.
- Correction preserves `changes_requested` and the manager reason in the portal.
  Native Needs Review/Open is verified without a `PUT`. A moved or closed
  opportunity fails rather than being pulled backward. Another review requires
  a newer captured submission.
- Correction returns `vendorNotification: "not_sent"`, separately from CRM
  delivery. Contact the vendor separately with the corrections. There is no
  automatic application-correction email sender or queued correction email.
  Native insurance-correction emails do not establish such a route.

`GET /api/internal/cron/application-review-outbox` is the authenticated recovery
path. Permanent mapping/identity failures need operator review; they must not
be treated as automatically queued recovery. Retrying a saved decision retains
the persisted delivered/failed status even if no job is claimable. An unreadable
status is unknown, not proof of delivery or queued recovery.

## 4. Wire and test L07 exact agreement completion

Follow [agreement completion integration](agreement-completion-integration.md).
The native issuance process must create the actual document, bind its IDs via
`POST /api/integrations/highlevel/agreements/issued`, then send a genuine
completed event to `POST /api/integrations/highlevel/agreements/completed`.
Both calls use `Authorization: Bearer <GHL_AGREEMENT_WEBHOOK_SECRET>` and the
same real document/template/contact/opportunity/location/season identities.
An unbound, superseded, mismatched, or incomplete document must not complete.

A completion atomically records the receipt, one notification item, and one
agreement field-delivery item. The historical stage-outbox table/route names
remain for compatibility, but the worker now verifies Approved/Open and changes
only Vendor Agreement Status from Sent to Signed. Already Signed is a verified
read-only result. It never changes the pipeline, stage, or lifecycle status.

The webhook immediately attempts its exact field-delivery item. Recovery uses
`GET /api/internal/cron/agreement-completion-stage-outbox`. A final exact GET
and field receipt prove CRM reconciliation only. The independent internal
notification queue is not proof of an email send; a connected sender, exact
provider receipt, and QA inbox evidence are required to accept notification.
Use an authorized test signer and QA-only native alerts for any genuine signing.

## 5. Resolve the L08 native-document bridge before claiming acceptance

The business requirement is insurance/document submission, Thomas's review,
correction/resubmission history, and a food-license gate when Thomas decides a
license is required. The original specification does **not** mandate buying a
separate malware-scanning product. A field on a native form, an email reply, or
a native Submitted/Approved value does not by itself provide the exact portal
document/version evidence used by final reservation.

The current portal implementation has a private-transfer primitive, bounded
file validation, protected ingress, a `pending_scan` gate, versioned manager
review, and a durable document outbox. It accepts PDF, PNG, and JPEG up to
10 MiB under its existing byte/type checks. These are current implementation
requirements, not newly inferred business requirements.

**Still missing:** the integrated bridge from real HighLevel uploads and
Thomas's native review decisions to this exact application/document/version
ledger, and its downstream delivery mapping. The existing primitive does not
provide a deployed storage adapter, scanner, native decision bridge, or email
sender. Resolve how the native process will satisfy or replace the current
unconnected gates before implementing and testing the bridge. Do not fabricate
scan or approval events to make it pass.

If the current private-transfer path is retained, its server-side worker must
stream actual bytes to private storage, derive size/digest/bounded samples, and
call `POST /api/integrations/highlevel/documents`. This source-bound route
resolves an existing application by exact contact/opportunity/location/season;
it does not accept a caller-selected application ID or make native storage
private by itself. The alternative internal ingress is
`POST /api/integrations/documents`. Both require the trusted ingress credential.
The current scan route is `POST /api/integrations/documents/:documentId/scan`;
manager review is `PATCH /api/admin/documents/:documentId/review` with a signed
session, version and idempotency key. These endpoints are not a completed
native integration.

## 6. Execute the matrix and record only demonstrated results

Run all five scenario groups for each workflow. Capture the deployment commit,
run timestamp, exact identities, before/after stage and fields, ledger/outbox
state, and duplicate count. For an actual native workflow or email action, add
its execution/message ID and recipient evidence. For an intentional no-op or
rejection, record zero calls/messages rather than requiring a fictional receipt.
Keep detailed identity evidence in restricted Linear tasks; use only top-level
headlines/status in Asana.

For QA recovery, invoke the authenticated exact-item or bounded worker after
the recorded state is eligible, without waiting for the normal schedule.
Record the normal production timing separately. Do not change live delays,
backdate business evidence, or let a recovery request process unrelated vendors.
The paused scheduler state is not evidence of automatic recovery.

Keep hosted cases RED until their listed evidence is attached. Existing
automated tests and limited native/email history remain useful scoped evidence;
they do not close missing issuance, document bridge, provider, or inbox checks.
If browser access is blocked by policy, record that blocker rather than bypassing
it. No hosted status changes to GREEN are made by this documentation update.
