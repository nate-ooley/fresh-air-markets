# Exact agreement completion integration

This is the portal-side foundation for the vendor agreement completion
workflow. It does not send email or create a document. It records an immutable
source receipt, queues one internal notification, and queues a separate exact
HighLevel opportunity-stage update only after a document has been bound to the
exact portal application that received it.

Apply these migrations to the reviewed portal database in order:

1. `001-application-handoff.sql`
2. `005-agreement-completion-outbox.sql`
3. `007-agreement-completion-stage-outbox.sql`
4. `009-agreement-stage-terminal-state.sql`

Set these private server variables in the verified deployment:

| Variable | Purpose |
| --- | --- |
| `GHL_AGREEMENT_WEBHOOK_SECRET` | A new random 32+ character secret used only by the two agreement webhooks. |
| `GHL_AGREEMENT_TEMPLATE_ID` | The one approved HighLevel agreement template ID. |
| `GHL_AGREEMENT_NOTIFICATION_EMAIL` | The internal QA/production notification recipient. Use a QA-only recipient in a QA deployment. |
| `GHL_API_TOKEN` | A sub-account private integration token with `opportunities.readonly` and `opportunities.write` for the stage worker. |
| `GHL_AGREEMENT_PIPELINE_ID` | Exact HighLevel pipeline ID expected for the signed agreement opportunity. |
| `GHL_AGREEMENT_SENT_STAGE_ID` | The only stage from which completion may advance the opportunity. |
| `GHL_AGREEMENT_COMPLETED_STAGE_ID` | The target stage after an exact completed agreement. |
| `CRON_SECRET` | A random 32+ character credential for the authenticated recovery endpoint. |
| Existing `DATABASE_URL`, `GHL_LOCATION_ID`, `FAME_MARKET_ACCOUNT_ID`, `FAME_SEASON_ID` | Pin the webhook to this database, HighLevel location, market, and season. |

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
sent. The stage worker reads the exact immutable opportunity ID, verifies its
contact, pipeline and location, allows only the configured agreement-sent or
already-completed stage, and then uses HighLevel v3 `PUT /opportunities/:id`
with the exact configured pipeline/stage IDs. It reads the result again before
recording delivery. A retry after a provider success but before the local
receipt sees the target stage and does not issue another PUT.

The completed webhook immediately attempts only its newly committed stage job.
If HighLevel is unavailable, the completion webhook remains acknowledged and
the fenced job stays durable. An authenticated scheduler may recover it with:

`GET /api/internal/cron/agreement-completion-stage-outbox`

using `Authorization: Bearer <CRON_SECRET>`. This endpoint returns aggregate
counts only. Do not configure a production cron cadence until the Vercel plan
supports the required frequency. No scheduler or email sender is enabled by
this repository by itself.

The worker only moves an opportunity that remains in the configured sent stage
and has `open` status. It preserves that status in the stage update and verifies
it again after the HighLevel readback. Identity, pipeline, status, source-stage,
and permanent provider rejections enter a terminal `failed` outbox state with a
safe error code; they are never automatically retried or reported as delivered.
Resolve the mapping before an operator explicitly requeues one of those rows.

The route rejects malformed, wrong-template, wrong-location, wrong-season,
wrong-contact, wrong-opportunity, non-completed, and oversized events before
they can create a completion or notification. An exact replay returns `200`
without a duplicate outbox item; reuse of an event ID with changed identity
returns `409`; transient storage failures return `503` so the same source event
can be retried.

The local test suite covers five handler boundary cases and five fake-transport
stage-delivery cases. The PostgreSQL suite adds concurrency, wrong-identity,
superseded-document, terminal-completion, both independent queues, stage
lease/retry, and rollback/retry cases. It uses the disposable CI database only.
A completed QA signature, HighLevel field mapping, actual workflow log,
administrator inbox delivery, and public signing flow still need a configured
QA deployment and an authorized test signer.
