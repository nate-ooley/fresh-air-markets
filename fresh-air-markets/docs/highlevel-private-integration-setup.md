# Fresh Air HighLevel Private Integration

Create this integration inside the Fresh Air subaccount
`aooAnUXF0COePorBo7wL`. This token connects the existing application review,
agreement and payment workers to their exact native records. It does not
configure Square or finish the planned native document bridge.

## Owner setup

1. In the Fresh Air subaccount, open **Settings → Private Integrations →
   Create new Integration**. Suggested name: **Fresh Air Vendor Portal**.
   Description: **Application review, agreement and payment status, payment
   email receipts, and native form-submission verification.**
2. Select the six implemented permissions in the table below. Also select
   `forms.readonly` for the upcoming document integration. Do not select all
   permissions.
3. The owner completes creation and copies the token privately. Save it in
   Vercel's **farmers-market** project as **Secret**, key **`GHL_API_TOKEN`**,
   environment **Preview**. Paste only the token, without a `Bearer ` prefix.
   Keep the token out of chat, screenshots, Asana, Linear, and source control.
4. Verify **Config** `GHL_LOCATION_ID=aooAnUXF0COePorBo7wL` in that same Preview
   environment. Keep `GHL_PAYMENT_EMAIL_ENABLED=false` and
   `GHL_PAYMENT_SYNC_ENABLED=false` until the mapped records and native QA
   recipients have been checked.
5. Redeploy the latest reviewed **Preview** deployment so it receives the new
   value. Give the developer the deployment URL and confirmation that the
   variable is saved; do not send the token. Production credential setup follows
   verified Preview acceptance.

HighLevel allows permissions to be edited later without generating a new
token. Its token creation screen reveals the token once. See the official
[Private Integrations instructions](https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken/index.html).

## Exact permissions

| Select this scope | Current use |
| --- | --- |
| `contacts.readonly` | GET exact contact; verify contact ID, location and current recipient email. |
| `opportunities.readonly` | GET exact application opportunity before and after an update. |
| `opportunities.write` | PUT the reviewed application stage or verified agreement/payment custom-field value on that same opportunity. |
| `locations/customFields.readonly` | GET exact field metadata; verify location, Opportunity model and permitted options. |
| `conversations/message.write` | POST `/conversations/messages` with fixed `type: Email`; send the payment invitation once. |
| `conversations/message.readonly` | GET `/conversations/messages/email/:id`; verify recipients and provider status. |
| `forms.readonly` — planned reader | GET `/forms/submissions` and, if needed, `/forms/`; verify native submission identity and saved file-field metadata. |

The first six are the implemented worker minimum. Scope spelling, including
slashes and `customFields` capitalization, follows the official
[scope list](https://marketplace.gohighlevel.com/docs/Authorization/Scopes/).
The [official Conversations v3 OpenAPI](https://github.com/GoHighLevel/highlevel-api-docs/blob/main/apps/v3/conversations-v3.json)
explicitly assigns `conversations/message.readonly` to the email GET.

No current worker needs ordinary `conversations.readonly`,
`conversations.write`, `contacts.write`, `forms.write`, media permissions,
HighLevel payment/invoice permissions, or document-signing API permissions.
The native form handles uploads, existing native workflows handle agreement
issuance, and Square handles payment processing. The repository's separate
legacy `ghl.ts` contact-upsert/note helper is disabled when the Fresh Air location
is selected or `FAME_MARKET_ACCOUNT_ID` is present, even if that mapping is empty.
Legacy demo/other-market calls cannot borrow the dedicated token or trigger
contact-tag automations. Other legacy deployments must omit that mapping and use
their own integration; their contact writes are outside this worker setup.

The message-write permission is shared across channels. This application's
Email-only payload and QA recipient guards prevent SMS; the permission itself
does not provide an email-only restriction.

## API version and first verification

Keep `Version: v3` on the implemented requests. Current official endpoint
pages explicitly specify it for [contact reads](https://marketplace.gohighlevel.com/docs/ghl/contacts/get-contact/),
[opportunity reads](https://marketplace.gohighlevel.com/docs/ghl/opportunities/get-opportunity/),
[opportunity updates](https://marketplace.gohighlevel.com/docs/ghl/opportunities/update-opportunity/),
[field metadata](https://marketplace.gohighlevel.com/docs/ghl/locations/get-custom-field/),
[message sends](https://marketplace.gohighlevel.com/docs/ghl/conversations/send-a-new-message/),
and [form submissions](https://marketplace.gohighlevel.com/docs/ghl/forms/get-forms-submissions/).
The email GET belongs to the official v3 specification, although that
operation omits a header-parameter declaration. The global
[versioning reference](https://marketplace.gohighlevel.com/docs/Versioning/)
confirms named v3 support; generic token examples still show an older date.

First use read-only requests against the exact authorized QA contact,
opportunity and configured fields. Verify the returned location and identifiers
before any write. A successful form-submission read supplies a real provider
sample for the planned bridge; it does not prove file contents were scanned,
reviewed, or approved. Then follow the [QA runbook](l06-l08-deployment-qa-runbook.md):
only `lnooley@gmail.com` and `nate@autocraftstudios.com` may receive test messages,
with Nate as the test administrator. Record scope verification separately from
successful hosted workflow tests.
