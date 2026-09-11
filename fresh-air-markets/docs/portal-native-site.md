# Portal-native site and intake (no CRM)

The marketing site and the vendor application both live in this app. Nothing
in this path calls HighLevel, Square or an email provider.

## Pages

| Route | Purpose |
| --- | --- |
| `/` | Home: hero, register section, newsletter signup, contact form |
| `/vendors` | Become a vendor: benefits, requirements, fees, how to apply, non-profits, FAQ |
| `/about` | Our story and mission |
| `/apply` | Vendor / non-profit application with electronic agreement signature |
| `/agreement` | The Vendor Agreement text vendors sign (edit in `src/app/agreement/page.tsx`) |
| `/messages` | Staff inbox: contact-form messages and newsletter signups |

Copy lives in the page files; images are in `public/site/`. Colors `navy`
and `sky` in `globals.css` match the logo.

## Application data path

`POST /api/apply` → `validatePortalApplication` → `submitPortalApplication`:

1. `persistApplicationHandoff` writes the same `fame_applications` and
   `fame_application_events` rows the CRM path would, with portal identifiers:
   `contact_id = portal:<sha256(email)>`, `opportunity_id =
   portal-opportunity:<hash>:<season>`, `location_id = GHL_LOCATION_ID` (or
   `portal` when unset). One application per email per season; a changed
   resubmission is a new source event on the same application.
2. The snapshot uses the keys the review step reads (`firstName`, `lastName`,
   `email`, `registrationType`, `businessName`/`orgName`, `vendorCategory`,
   `vendorDatesRequested`, `message`/`mission`).
3. The typed signature is stored in `fame_agreement_signatures` and a
   `fame_agreement_completions` row is written (template =
   `VENDOR_AGREEMENT_VERSION`, document = signature id). That satisfies the
   final-reservation gate. No CRM outbox rows are created.

Downstream is unchanged: staff review at `/applications/{id}`, upload and
approve documents there, finalize the reservation, create the private vendor
payment link and copy it to the vendor.

## Requirements

- Migration `023-portal-native-intake.sql` applied.
- Production variables `FAME_MARKET_ACCOUNT_ID`, `FAME_SEASON_ID`,
  `DATABASE_URL`; `GHL_LOCATION_ID` is reused only as the location label.
- Rate limiting reuses the inquiry limiter (migration 002).

## Not included yet

- Outbound email (approval, document request, payment request, confirmation,
  reminders). Staff copy links and email vendors from their own mailbox until
  an email provider is added.
- Vendor self-service document upload; staff upload documents for now.
