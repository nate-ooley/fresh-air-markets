# Continuous vendor pipeline repair

## Problem and resulting behavior

The review adapter previously selected the Production application pipeline even
in Preview. Agreement delivery allowed a different pipeline although the stored
application requires one immutable opportunity. Checkout creation then changed
the database to Payment Pending without scheduling the matching HighLevel stage.
Those mismatches prevented a single vendor from completing the intended journey.

Review, agreement, payment request, and paid status now use the same selected
application pipeline. Preview selects `GHL_QA_APPLICATION_PIPELINE_ID` and
Production selects `GHL_APPLICATION_PIPELINE_ID`. The optional legacy
`GHL_AGREEMENT_PIPELINE_ID` must match the selected pipeline. Stage updates send
only `pipelineStageId`; they do not move the opportunity or reopen its status.

The intended accepted path is Needs Review → Approved → Agreement Signed →
Payment Pending → Payment Confirmed. Approved can also serve as the configured
agreement-sent stage while the issued agreement awaits signing. Agreement Signed,
Payment Pending, and Payment Confirmed must have three distinct stage IDs.

Migration 020 queues Payment Pending when a valid Square checkout commits.
Both payment-stage workers wait for the exact agreement-stage delivery receipt.
They share a reservation lock so a delayed Pending action cannot run after the
Paid action. A fast paid webhook can advance Agreement Signed directly to Payment
Confirmed; obsolete Pending work cancels. The webhook remains free to commit
while a CRM operation is running. Provider-side human edits cannot be locked
atomically by these workers and remain a documented integration limit.

## Native configuration verified September 8, 2026

| Environment | Pipeline | Verified configuration |
| --- | --- | --- |
| Preview QA | QA ONLY - FAME Intake Tests (`inltlurydNKw0FerWQXn`) | Added Agreement Signed; all nine stages persisted after reload. Payment Pending, Payment Confirmed, and Changes Requested already existed. |
| Production | Fresh Air Markets-Vendor Management (`wAMTir0CzlAStr9GgGvr`) | Added Agreement Signed and Changes Requested; all nine stages persisted after reload. Payment Pending and Payment Confirmed already existed. |

The exact Fresh Air location is `aooAnUXF0COePorBo7wL`. Existing opportunity
records and stage probabilities were preserved. No workflow was published and
no email, SMS, or payment was sent by this configuration work. Stage IDs still
need to be retrieved and configured; names are not substitutes.

## Verification and remaining acceptance

Automated checks cover selected pipeline identity, current QA recipient checks,
stage-only updates, stale retries, queued agreement prerequisites, checkout
rollback/recovery, and concurrent Pending/Paid workers. The six-worker scheduler
runs review, agreement, pending, email, paid, then expiry. It remains disabled.
See the exact-commit CI linked in Linear for final database/build results.

Hosted acceptance still requires authorized Vercel access, the private database
with migrations 001–020, the confirmed booth capacity, configured stage IDs,
native QA notification routing, actual Sandbox checkout/webhook proof, inbox
evidence, and canonical website routing. Automated transport fixtures are not
evidence that those external workflows ran.

The document flow has a separate unfinished bridge: HighLevel document upload
and Thomas's review decisions must reach the portal's document ledger. The
original business reference requires insurance approval and food-license
approval when Thomas decides it is required. A separate malware scanning service
was not specified there; it is a gate introduced by the current implementation.
Resolve that integration against the existing HighLevel process before declaring
the full approval-to-payment journey complete.
