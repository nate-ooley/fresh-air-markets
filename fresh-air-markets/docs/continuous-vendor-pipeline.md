# Vendor workflow alignment

## Corrected behavior

The original Asana reference (task 1218142524078858, sections 4, 11, 23 and 26)
keeps the application pipeline simple and records agreement/payment progress in
Opportunity custom fields. Earlier adapters incorrectly used extra operational
stages. The repaired adapters preserve the exact opportunity in Approved with
lifecycle status open and update only the corresponding custom field.

| Event with verified evidence | HighLevel field | Value |
| --- | --- | --- |
| Bound agreement completed | Vendor Agreement Status | Signed |
| Valid checkout committed, before email | Vendor Payment Status | Ready for Payment |
| Exact email provider receipt confirms sent/delivered | Vendor Payment Status | Payment Sent |
| Exact signed Square COMPLETED event reconciled | Vendor Payment Status | Paid |

Preview uses the separate `GHL_QA_APPLICATION_PIPELINE_ID`; Production uses
`GHL_APPLICATION_PIPELINE_ID`. Configured field IDs must belong to the correct
Fresh Air location and pass metadata checks. The API token also needs
`locations/customFields.readonly`. Neither a field name nor an extra stage ID is
a substitute for the actual custom-field ID.

Migration 021 replaces stage-only acknowledgements with verified field receipts.
Apply it while old workers are paused. Legacy successful/in-flight jobs retain
an audit snapshot and are fenced/requeued for verification; migration does not
call HighLevel or mark them green. Expired or otherwise obsolete payment work
is cancelled by current eligibility checks. Failed/manual-review work is not
silently revived. Never run the old stage-writing workers after this migration.

The same reservation advisory lock orders Ready, Payment Sent and Paid writes.
Provider email proof is stored before the separate CRM synchronization, so a CRM
failure cannot erase a sent email or cause a second email POST. A late Payment
Sent action skips an exactly reconciled paid reservation. Native human edits
are not locked by our worker; diverged or closed opportunities require review.

## Native configuration evidence

Correct subaccount: `aooAnUXF0COePorBo7wL`.

- QA Intake pipeline: `inltlurydNKw0FerWQXn`.
- Production Vendor Management pipeline: `wAMTir0CzlAStr9GgGvr`.
- Earlier work added Agreement Signed, Payment Pending, Payment Confirmed and
  Changes Requested stages. Those additions are not proof of the original
  workflow working. The three agreement/payment stages are no longer used by
  the repaired adapters. They have not been deleted while references remain
  unaudited. Changes Requested still needs a separate review-workflow correction.
- September 9: created and read back Contact file field Food License / Permit,
  key `contact.food_license__permit`, in Additional Info. It accepts one PDF,
  JPG/JPEG, or PNG. No contact was changed and no message was sent. The field
  must still be placed on a tested upload form and bound to exact application
  review evidence.
- AI Studio project `1779802876495102326` lists default domain
  `https://fresh-air-landing.vibepreview.com` and live apex/www domains. UI
  configuration alone does not prove the default domain serves independently.

## Remaining acceptance

The six recovery workers remain disabled pending verified native routing.
Hosted acceptance requires Vercel access, migrations 001–021 in the private
Preview database, actual Approved stage and custom-field IDs, booth capacity,
and proof that every field-triggered QA notification is contained to authorized
recipients. Then test real Square Sandbox checkout/webhooks, email inboxes,
replays, failures and canonical website routing.

HighLevel document uploads and Thomas's decisions still need a verified bridge
to the portal's document ledger. The original reference did not require a
separate malware-scanning product; resolve the current implementation's
unconnected private-transfer/scanning gates against the native process.
Automated provider fixtures and PostgreSQL tests do not prove hosted acceptance.
