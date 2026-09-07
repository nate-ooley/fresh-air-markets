# Exact agreement completion integration

This is the portal-side foundation for the vendor agreement completion
workflow. It does not send email, create a document, or change any HighLevel
record on its own. It records an immutable source receipt and queues one
internal notification only after a document has been bound to the exact portal
application that received it.

Apply these migrations to the reviewed portal database in order:

1. `001-application-handoff.sql`
2. `005-agreement-completion-outbox.sql`

Set these private server variables in the verified deployment:

| Variable | Purpose |
| --- | --- |
| `GHL_AGREEMENT_WEBHOOK_SECRET` | A new random 32+ character secret used only by the two agreement webhooks. |
| `GHL_AGREEMENT_TEMPLATE_ID` | The one approved HighLevel agreement template ID. |
| `GHL_AGREEMENT_NOTIFICATION_EMAIL` | The internal QA/production notification recipient. Use a QA-only recipient in a QA deployment. |
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

The completion receipt and one `agreement-completed` notification item commit
in the same database transaction. The outbox has an idempotency key, lease
token, retry count, next-attempt time, and safe error code. A worker may claim
it with `claimAgreementNotificationOutbox` or
`dispatchAgreementNotificationOutbox`; its delivery function is injected, so
the repository makes no outbound mail call. Configure and test that worker in
the QA account before any production recipient is used.

The route rejects malformed, wrong-template, wrong-location, wrong-season,
wrong-contact, wrong-opportunity, non-completed, and oversized events before
they can create a completion or notification. An exact replay returns `200`
without a duplicate outbox item; reuse of an event ID with changed identity
returns `409`; transient storage failures return `503` so the same source event
can be retried.

The local test suite covers five handler boundary cases. The PostgreSQL suite
adds concurrency, wrong-identity, superseded-document, terminal-completion,
outbox lease/retry, and rollback/retry cases. It uses the disposable CI
database only. A completed QA signature, HighLevel webhook field mapping,
administrator inbox delivery, and public signing flow still need a configured
QA deployment and an authorized test signer.
