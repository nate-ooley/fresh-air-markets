# HighLevel workflow intake (vendor applications)

Vendor applications enter the portal only through HighLevel. The portal
accepts HighLevel's native **Workflow → Webhook action** payload at:

```
POST https://farmers-market-wine.vercel.app/api/integrations/highlevel/workflow/applications
Authorization: Bearer <GHL_APPLICATION_WEBHOOK_SECRET>
```

No custom JSON has to be authored in HighLevel. The route normalizes the
contact's standard fields, custom fields (matched by display name, for example
"Vendor Business Name", "Vendor Category", "Vendor Dates Requested",
"Registration Type", "Organization Name", "Mission"), `location.id`, and any
Custom Data keys, then stores it through the same validated, idempotent
handoff as `/api/integrations/highlevel/applications`. Wrong location, wrong
secret, or a payload with no contact is rejected before anything is stored.

## One-time setup

1. **Portal secret.** Generate a 48-character secret and store it in Vercel
   Production as `GHL_APPLICATION_WEBHOOK_SECRET`:

   ```sh
   cd fresh-air-markets
   SECRET=$(openssl rand -hex 24); echo "GHL_APPLICATION_WEBHOOK_SECRET=$SECRET"
   printf '%s' "$SECRET" | npx vercel env add GHL_APPLICATION_WEBHOOK_SECRET production --sensitive
   ```

   Keep the printed value for step 3, then redeploy Production.

2. **Workflow.** In the Fresh Air sub-account (`aooAnUXF0COePorBo7wL`):
   Automation → Workflows → **Create Workflow** → Start from scratch.
   Name it "Vendor application → portal".

   - **Trigger:** *Form Submitted*, filter *Form is* the vendor application
     form (`fresh-air-vendor-application`). If applications also arrive
     another way, add a second trigger *Contact Tag Added* for the tag that
     marks applicants.
   - **Action:** *Webhook* (Custom Webhook).
     - Method: `POST`
     - URL: `https://farmers-market-wine.vercel.app/api/integrations/highlevel/workflow/applications`
     - Headers: `Authorization` = `Bearer <the secret from step 1>`
     - Custom Data (optional but recommended):
       `opportunityId` = `{{opportunity.id}}` when the trigger is
       opportunity-related; `seasonId` = `2026-2027`.
   - Save and **Publish**.

3. **Verify** with one test contact: submit the form, then open
   `/applications` in the portal. The applicant appears within seconds. The
   Workflow's execution log shows the portal's response (`201` captured,
   `200` duplicate, `400`/`401` rejected).

## Behaviour

- **Idempotent.** HighLevel sends no event ID, so the portal derives one from
  the contact ID and the normalized content. An exact re-delivery is a
  duplicate; a changed resubmission is a new source event for the same
  application.
- **Opportunity ID.** Approval in the portal requires the application's CRM
  opportunity ID. Include `opportunityId` in Custom Data or trigger the
  workflow from an opportunity event so it is captured; without it the
  reviewer sees "Application is missing its CRM opportunity identity".
- **Dates.** Multi-select values arrive as text; the portal splits them and
  accepts the calendar labels (for example `Sat, Oct 3, 2026`), ISO dates,
  or the full-season labels.
- **Audit.** The complete original webhook body is kept inside the stored
  snapshot under `raw`; only the normalized keys are shown to reviewers.
