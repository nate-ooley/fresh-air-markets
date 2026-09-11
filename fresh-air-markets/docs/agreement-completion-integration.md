# Exact agreement completion integration

This is the portal-side foundation for the vendor agreement completion
workflow. It does not send email or create a document. It records an immutable
source receipt, queues one internal notification, and queues a separate exact
HighLevel agreement-status custom-field update only after a document has been bound to the
exact portal application that received it.

Apply all migrations 001–023 to the reviewed database in numeric order, with
old stage-writing workers paused during migration 021.

Set these private server variables in the verified deployment:

| Variable | Purpose |
| --- | --- |
| `GHL_AGREEMENT_WEBHOOK_SECRET` | A new random 32+ character secret used only by the two agreement webhooks. |
| `GHL_AGREEMENT_TEMPLATE_ID` | The one approved HighLevel agreement template ID. |
| `GHL_AGREEMENT_NOTIFICATION_EMAIL` | The internal notification recipient. Use `nate@autocraftstudios.com` for QA. |
| `GHL_API_TOKEN` | A sub-account private integration token with `contacts.readonly`, `opportunities.readonly`, `opportunities.write` and `locations/customFields.readonly` for the field worker. |
| `GHL_APPLICATION_PIPELINE_ID` | Exact Production application pipeline, shared by review, agreements and payment. |
| `GHL_QA_APPLICATION_PIPELINE_ID` | Preview only: the separate QA application pipeline, shared by the same workflow steps. It must differ from the configured Production pipeline. |
| `GHL_AGREEMENT_PIPELINE_ID` | Optional legacy alias. If set, it must equal the selected application pipeline. A different agreement pipeline is rejected. |
| `GHL_APPLICATION_APPROVED_STAGE_ID` | The unchanged Approved stage in the selected application pipeline. |
| `GHL_AGREEMENT_STATUS_FIELD_ID` | Exact Opportunity Vendor Agreement Status field ID, with Not Sent, Sent and Signed options. |
| `GHL_PAYMENT_QA_ROUTING_VERIFIED` | Preview only: `true` after all native QA downstream email recipients, including admin Nate, have been verified. |
| `CRON_SECRET` | A random 32+ character credential for the authenticated recovery endpoint. |
| Existing `DATABASE_URL`, `GHL_LOCATION_ID`, `FAME_MARKET_ACCOUNT_ID`, `FAME_SEASON_ID` | Pin the webhook to this database, HighLevel location, market, and season. |

The worker requires `VERCEL=1` and `VERCEL_ENV=preview` or `production`.
Preview selects the QA pipeline and checks the current exact contact email
against `lnooley@gmail.com` and `nate@autocraftstudios.com` before each field
mutation. The location must be `aooAnUXF0COePorBo7wL`. Production selects the
Production application pipeline and rejects residual `GHL_QA_*` or
`GHL_PAYMENT_QA_*` controls. Approval and agreement processing do not depend on
Square credentials; payment workers add their own payment environment checks.

An agreement always belongs to the same immutable application opportunity.
Neither issuance nor completion creates a second opportunity or moves the
existing opportunity into another pipeline. The opportunity remains Approved
and open; an exact bound signing event moves Vendor Agreement Status from Sent
to Signed. A native workflow must actually issue the document and make the two
calls below.

HighLevel must make two authenticated **server-side** webhook calls. Do not put
the shared secret in AI Studio, a public form, browser code, or a signed link.
Both calls use `Authorization: Bearer <GHL_AGREEMENT_WEBHOOK_SECRET>`.

After a document is issued, call:

`POST /api/integrations/highlevel/agreements/issued`

```json
{
  "eventId": "stable-issuance-event-id",
  "documentId": "actual-generated-document-id",
  "templateId": "configured-agreement-template-id",
  "contactId": "existing-highlevel-contact-id",
  "opportunityId": "exact-current-opportunity-id",
  "locationId": "aooAnUXF0COePorBo7wL",
  "seasonId": "2026-2027",
  "status": "sent"
}
```

After a completed signing event, call:

`POST /api/integrations/highlevel/agreements/completed`

with the same identifiers and `"status": "completed"`. Completion is refused
unless an active issuance binding has the same document, template, contact,
opportunity, location, market, and season. A new unsigned document supersedes
the old one; a completion for an old document is rejected. A completed
application cannot be completed by another document later.

The completion receipt, one `agreement-completed` notification item, and one
`agreement-completed-stage` item commit in the same database transaction. The
two outboxes are independent: CRM delivery never claims that an email was
sent. The field worker reads the exact immutable opportunity ID, verifies its
contact, pipeline, Approved/open state and configured custom-field metadata,
then changes only Vendor Agreement Status from Sent to Signed. A Signed value
is an idempotent read-only result. Delivery requires a verified field receipt
with matching IDs and a final GET; an old stage acknowledgement cannot satisfy
this contract.

The completed webhook immediately attempts only its newly committed stage job.
If HighLevel is unavailable, the completion webhook remains acknowledged and
the fenced job stays durable. An authenticated scheduler may recover it with:

`GET /api/internal/cron/agreement-completion-stage-outbox`

using `Authorization: Bearer <CRON_SECRET>`. This endpoint returns aggregate
counts only. Do not configure a production cron cadence until the Vercel plan
supports the required frequency. No scheduler or email sender is enabled by
this repository by itself.

The worker never changes lifecycle status, pipeline or stage. Identity, field,
pipeline, status and permanent provider rejections enter a terminal failed
outbox state with a safe error code. Resolve the mapping before explicitly
requeueing. Migration 021 preserves old receipt history and requires field
verification; it does not upgrade old receipts to successful field delivery.

The route rejects malformed, wrong-template, wrong-location, wrong-season,
wrong-contact, wrong-opportunity, non-completed, and oversized events before
they can create a completion or notification. An exact replay returns `200`
without a duplicate outbox item; reuse of an event ID with changed identity
returns `409`; transient storage failures return `503` so the same source event
can be retried.

The local test suite covers handler boundary cases and fake-transport
field delivery, including one QA opportunity moving from review to Approved
while recording Signed in its agreement field, a mismatched legacy pipeline alias, current QA
contact checks, and terminal/diverged states. The PostgreSQL suite adds concurrency, wrong-identity,
superseded-document, terminal-completion, both independent queues, stage
lease/retry, and rollback/retry cases. It uses the disposable CI database only.
A completed QA signature, HighLevel field mapping, actual workflow log,
administrator inbox delivery, and public signing flow still need a configured
QA deployment and an authorized test signer.
