# HighLevel payment email delivery

This provider adapter is disabled by default. It does not create contacts, enroll
workflows, move opportunities, send SMS, or retry an email POST. The separate
durable payment email dispatcher must own the invitation, recipient snapshot,
lease, `send_started` record, receipts and recovery decisions.

## Server configuration

| Variable | Type | Required value |
| --- | --- | --- |
| `GHL_PAYMENT_EMAIL_ENABLED` | Config | `true` only after the correct account and email routing are verified |
| `GHL_PAYMENT_DELIVERY_MODE` | Config | `qa` for Preview, `production` for Production |
| `GHL_API_TOKEN` | Secret | Private integration token scoped to the Fresh Air subaccount |
| `GHL_LOCATION_ID` | Config | `aooAnUXF0COePorBo7wL` |
| `FAME_MARKET_ACCOUNT_ID` | Config | The private portal market account; never `demo-market` |
| `GHL_PAYMENT_EMAIL_FROM` | Config | One verified sending mailbox, without display-name syntax or a recipient list |
| `GHL_APPLICATION_PIPELINE_ID` | Config | The actual Production application pipeline ID |
| `GHL_QA_APPLICATION_PIPELINE_ID` | Config | Preview only: a separate, verified QA pipeline ID |
| `GHL_APPLICATION_APPROVED_STAGE_ID` | Config | Approved stage in the selected pipeline |
| `GHL_AGREEMENT_STATUS_FIELD_ID` | Config | Exact Opportunity Vendor Agreement Status field ID |
| `GHL_PAYMENT_STATUS_FIELD_ID` | Config | Exact Opportunity Vendor Payment Status field ID |
| `GHL_PAYMENT_QA_ROUTING_VERIFIED` | Config | Preview only: `true` after native downstream test routing is verified |
| `FAME_VENDOR_PORTAL_ORIGIN` | Config | Exact Preview HTTPS `*.vercel.app` origin; Production must be `https://freshairmarketsandevents.com` |

Preview requires Vercel's `VERCEL=1`, `VERCEL_ENV=preview`,
`SQUARE_ENVIRONMENT=sandbox` and `SQUARE_ALLOW_LIVE_PAYMENTS=false`.
Production requires `VERCEL_ENV=production`, `SQUARE_ENVIRONMENT=production`,
`SQUARE_ALLOW_LIVE_PAYMENTS=true` and no residual `SQUARE_QA_*`,
`GHL_PAYMENT_QA_*` or `GHL_QA_APPLICATION_PIPELINE_ID` values.

The QA routing flag records an operational prerequisite; it is not evidence by
itself. Verify all native downstream recipients first. Only
`lnooley@gmail.com` and `nate@autocraftstudios.com` are accepted as Preview
recipient mailboxes. Test administrators must be routed to Nate. CC, BCC,
SMS, scheduled delivery and reply-all are never included by the adapter.

The exact implemented token scopes are `contacts.readonly`,
`opportunities.readonly`, `opportunities.write`,
`locations/customFields.readonly`, `conversations/message.write` and
`conversations/message.readonly`. The last two authorize the email POST and
receipt GET respectively. The message-write scope covers multiple channels;
the adapter's fixed Email type and recipient guards enforce this project's
email-only behavior. Ordinary `conversations.readonly` and
`conversations.write` are not used by the current dispatcher. See the
[Private Integration setup](highlevel-private-integration-setup.md) for the
scope-to-endpoint mapping and separate planned `forms.readonly` access.

## Dispatch contract

1. Load the committed reservation and exact application identity. Create one
   durable notification intent and encrypted invitation, unique for the intended
   reservation/revision/invitation generation.
2. Call `preflightPaymentEmail`. It reads the exact CRM contact and opportunity,
   requiring matching contact, location, current email, selected pipeline,
   Approved/open status, Vendor Agreement Status Signed and Vendor Payment Status Ready for Payment. Configured field metadata and the exact local readiness receipt must also verify. No CRM write occurs.
3. Recheck eligibility under the dispatcher's reservation lock, then commit
   `send_started` before sending. Erase stored invitation ciphertext at that
   boundary; keep the current process's payload only for the one send attempt.
4. Call `sendPaymentEmail` once. Save its provider IDs on acceptance. Every
   timeout, rejected HTTP response or unusable response is `uncertain`; the
   adapter never resubmits. A crash after `send_started` must also park the job.
5. Call `verifyPaymentEmailReceipt` using nonsecret receipt context. It checks
   provider email ID, parent message ID, conversation, location, contact,
   outbound direction, the exact subject/reference, singleton To and empty
   CC/BCC. Store pending/sent/delivered/failed evidence without upgrading
   acceptance into delivery.
6. Persist verified sent/delivered email evidence before synchronizing Vendor
   Payment Status to Payment Sent. Use the shared reservation lock with Paid,
   recheck the exact current checkout and never overwrite reconciled Paid.
   A CRM-only failure retries only that field synchronization (at most five
   attempts), never the email POST. The manager UI shows this separate status.

The 48-hour deadline comes from the existing payment order. Sending, retrying,
or reviewing an email never resets it. Invitations must use the exact configured
`/vendor/payment#token=...` URL; query parameters, alternative paths/hosts and
noncanonical tokens are refused. Receipt polling needs no token and can continue
after the payment deadline.

## Uncertain delivery and verification limits

HighLevel's documented send-message schema has no idempotency key or
caller-supplied message ID. Exactly-once external email delivery cannot be
promised. The local dispatcher can prevent an automatic duplicate submission;
it cannot resolve a provider timeout by assuming the message failed.

If provider IDs are lost, this adapter leaves the job uncertain. An operator may
inspect the exact contact's conversation and email records using the unique
nonsecret notification reference. Finding no record does not prove the message
was never sent. Do not rotate the invitation or resend until that uncertainty
is deliberately resolved. Never use broad contact search or the newest message
as a receipt.

The provider's `delivered` status remains provider evidence. Final acceptance
also requires the authorized test inbox to show the correct recipient, amount,
deadline and usable private link, followed by the real Square Sandbox journey.
The isolated tests use mock transports and send nothing.

## Official API references

- [Version header](https://marketplace.gohighlevel.com/docs/Versioning/): current
  `Version: v3` on each request.
- [Get Contact](https://marketplace.gohighlevel.com/docs/ghl/contacts/get-contact/):
  `GET /contacts/:contactId` for exact identity and primary email verification.
- [Get Opportunity](https://marketplace.gohighlevel.com/docs/ghl/opportunities/get-opportunity/):
  `GET /opportunities/:id` for exact application pipeline/stage verification.
- [Send message](https://marketplace.gohighlevel.com/docs/ghl/conversations/send-a-new-message/):
  `POST /conversations/messages`, Email type, explicit contact and To address,
  returning message, conversation and email message IDs.
- [Get email](https://marketplace.gohighlevel.com/docs/ghl/conversations/get-email-by-id/):
  `GET /conversations/messages/email/:id` exposes actual recipients and status.
- [Search conversations](https://marketplace.gohighlevel.com/docs/ghl/conversations/search-conversation/)
  and [Get messages](https://marketplace.gohighlevel.com/docs/ghl/conversations/get-messages/):
  optional operator investigation when a receipt is missing. The current
  dispatcher does not call these endpoints; conversation search would require
  the additional `conversations.readonly` scope if later implemented.
- [Scopes](https://marketplace.gohighlevel.com/docs/Authorization/Scopes/):
  exact scope names are listed above. This adapter requires no contact
  write/upsert permission. The [official v3 Conversations OpenAPI](https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/v3/conversations-v3.json)
  explicitly assigns `conversations/message.readonly` to the email receipt GET;
  the summary scopes table does not list every message-read endpoint.
