# L06–L08 QA matrix

This checklist defines five scenario groups per workflow for the current
original-spec-aligned implementation. It records **hosted acceptance**, not a
unit-test scoreboard. Every row below remains **RED / unverified** until the
listed evidence is attached. Automated tests and earlier scoped native runs
can support a row but do not prove the complete current deployment.

Use only `lnooley@gmail.com` and `nate@autocraftstudios.com` for vendor and
administrator test messages; use Nate for the internal QA destination. No SMS
or live-contact/admin messages. Preserve existing applicant history.

## Current contract and evidence scope

- Apply and verify all migrations **001–022** on the reviewed private QA database
  with old stage-writing workers paused. Migration 021 retains legacy history
  and requires exact `ghl_opportunity_fields_v1` receipts; it does not prove
  hosted delivery.
- Use one selected application pipeline: Preview's separate QA pipeline or
  Production's configured pipeline. L06 uses existing Needs Review, Approved,
  and Declined stages. Do not add Changes Requested or a separate agreement
  pipeline to satisfy these tests.
- After approval, the same opportunity stays Approved/Open. Agreement Signed
  and payment Ready for Payment → Payment Sent → Paid are Opportunity field
  values. L07 proves the Signed field only; payment needs separate acceptance.
- `request_changes` records the reason, keeps native Needs Review/Open, makes
  no `PUT`, and returns `vendorNotification: "not_sent"`. No automatic
  application-correction email exists.
- L08's native upload/review-to-ledger bridge is not implemented. The current
  private-transfer/scanning gates are implementation choices awaiting alignment
  with native document review, not a business mandate for a new scanner product.

For each run, record timestamp, commit/deployment, verified QA database and
environment, exact scoped IDs, before/after state, provider call counts, and
duplicates. Detailed evidence belongs in restricted Linear subtasks; Asana
shows only the top-level workflow headline/status. Do not put secrets, document
links, filenames, storage keys, or full file hashes in either tracker.

| Workflow | Required identity evidence |
| --- | --- |
| L06 | Application/source-event/contact/opportunity/review-event/outbox IDs and idempotency key; exact selected pipeline/stage. |
| L07 | Application, issued/completed source events, document/template/contact/opportunity/completion IDs; separate notification and field-outbox IDs; configured agreement field ID and exact verified receipt. |
| L08 | Application/contact/opportunity/document IDs, kind/version, stable source event/file identity, validation/review events and document-outbox identity; native-to-portal mapping evidence. |

Capture a workflow execution and provider message ID only when the action
actually occurs. Intentional no-ops need zero-mutation/message evidence, not an
invented workflow execution. Queued notification, provider acceptance, delivery,
and observed inbox receipt are separate results. Record normal timing and any
QA acceleration; never change live waits to speed a test.

## L06 — application review and approval

| ID | QA scenario | Expected mapping and proof | Hosted status | Remaining work |
| --- | --- | --- | --- | --- |
| L06-1 | Approve the exact current QA application | Latest source event creates one review event/outbox. Direct reads verify the stored contact/opportunity/location in the selected pipeline; only Needs Review/Open changes to Approved/Open. Capture exact native execution and QA-only receipts for any triggered onboarding actions separately. | **RED** — isolated and earlier native checks do not prove this deployed chain. | Verified configuration/migrations, real form capture, signed-in review, provider readback, and downstream recipient evidence. |
| L06-2 | Record a correction without inventing a stage or email | Portal stores `changes_requested` with the exact reason/source event. Native Needs Review/Open remains unchanged, with zero `PUT` and zero correction-email calls. API/UI disclose `vendorNotification: not_sent`. A newer captured submission is required before approval; already failed/delivered outbox replays retain their real status. | **RED** — repair and focused tests exist; no current hosted evidence. | Deploy the correction repair, run normal/replay/diverged cases, and verify the explicit manual-contact limitation. Automatic correction notification remains a separate unimplemented capability. |
| L06-3 | Decline the exact current QA application | One decision/outbox changes only the stored Needs Review/Open opportunity to Declined/Open. Review reason remains in the portal; no other application or season changes. Verify QA containment for any configured native notification. | **RED** — no complete current hosted proof attached. | Exact stage mapping, protected QA decision, readback and any real notification receipt. |
| L06-4 | Pressure-test duplicate clicks, replay and recovery | Concurrent requests with the same key/content yield one decision/outbox. Changed content conflicts. Race immediate delivery and recovery: at most one effective target change; crash-after-success retries read the correct target without a second update. Stored failed work must not be represented as automatically queued. | **RED** — disposable database/provider fixtures cover portions only. | Controlled hosted concurrency, same-job recovery, permanent-error replay, and provider/ledger duplicate counts. |
| L06-5 | Stop wrong, stale, unauthorized or diverged inputs | Signed-out, wrong-market, stale-source and missing identity fail before review/outbox mutation. Provider identity/QA-email mismatch or moved/closed opportunity fails before `PUT`; an already committed decision may retain a failed outbox and must be reported that way. No live message or cross-record update. | **RED** — guard coverage is not hosted proof. | Exercise both pre-commit and post-commit failures against exact QA records; capture correct audit state and zero external mutations. |

## L07 — agreement completion

| ID | QA scenario | Expected mapping and proof | Hosted status | Remaining work |
| --- | --- | --- | --- | --- |
| L07-1 | Complete one genuinely issued QA agreement | Bind the real issued document/template to the exact application/contact/opportunity before completion. One completion atomically creates independent notification and field-delivery items. Exact Approved/Open opportunity changes Vendor Agreement Status from Sent to Signed, with matching field receipt; pipeline/stage/status remain unchanged. | **RED** — code and provider fixtures exist; real issuance/signature/bridge acceptance is not established. | Verified native issued/completed calls, actual field metadata/IDs, authorized QA signer, and full deployed identity/readback evidence. |
| L07-2 | Pressure-test duplicate and concurrent completion | Replayed exact completed event yields one immutable completion and one item in each queue. Changed identity under the same event ID conflicts. Concurrent dispatch results in one effective Signed change. No duplicate native notification; queue state alone does not prove email. | **RED** — automated concurrency evidence covers the ledger, not hosted email. | Controlled authenticated event replay plus provider field/workflow counts. Connect and verify the separate QA notification sender before claiming its email success. |
| L07-3 | Recover a lost field receipt after provider success | Interrupt after the exact field becomes Signed. Recovery verifies Signed and stores the exact field receipt without a second `PUT` or notification. Old stage-only acknowledgements cannot satisfy the new contract. | **RED** — adapter/migration fixtures exist; no deployed recovery record. | Apply 021 with old workers paused, exercise the exact recovery job and retain before/after field and legacy audit evidence. |
| L07-4 | Reject unbound, superseded or mismatched agreements | Wrong document/template/contact/opportunity/location/season or non-completed status cannot create a completion or its queues. A superseded issuance cannot complete the current application. Keep correction-document identity separate from earlier issued history. | **RED** — handler/database tests do not prove the native event payload. | Send controlled invalid QA events and show rejection with zero completion, field update and message. |
| L07-5 | Fail safely on native identity, field or lifecycle divergence | A closed/non-Approved opportunity, wrong pipeline/contact, unapproved current QA email, wrong/duplicate field metadata, or unexpected agreement value cannot be forced to Signed. Persist a safe terminal field-job failure when appropriate. No reopening, stage change, unrelated field overwrite or live alert. | **RED** — fake transports cover these guards only. | Verified native field metadata and selected pipeline; hosted negative cases and evidence for both independent notification/field outcomes. |

## L08 — insurance and food-license documents

The business workflow is submission → Thomas's review → approval or correction
→ versioned resubmission. Thomas decides whether a food license is required;
an upload or a reply does not itself approve a document. Final reservation needs
current approved insurance and a current approved food license when required.
The native upload/review bridge and downstream provider adapter remain missing.
Do not synthesize validation, scan, or review evidence to close that gap.

| ID | QA scenario | Expected mapping and proof | Hosted status | Remaining work |
| --- | --- | --- | --- | --- |
| L08-1 | Capture a valid submission without auto-approval | Real QA insurance and required food-license uploads map to the exact application/contact/opportunity and immutable document version. Submission stays pending review until the selected validation/review path is satisfied. Existing private-transfer code accepts PDF/PNG/JPEG up to 10 MiB with actual-byte checks; this does not prove a deployed bridge. | **RED** — validation/ledger primitives and limited user-confirmed email receipt are partial evidence. | Implement and deploy the native upload/review bridge; align or replace the unconnected private-transfer/scan gates with the native process, then prove actual submission and Thomas's mapped review. |
| L08-2 | Refuse invalid files and unauthorized validation | Exercise empty, corrupt, unsupported and MIME/signature/extension-mismatched samples, plus at-limit and over-limit sizes. Under the selected implementation, rejected input must not become an approved/current usable document or trigger a success message. A fake or unauthorized scan/review callback cannot clear a gate. | **RED** — bounded validation and route tests exist only. | Test actual source bytes through the implemented bridge and its chosen validation path. A separate commercial scanner is not a business prerequisite. |
| L08-3 | Keep two QA vendors and food-license decisions isolated | Distinct uploads/reviews remain bound to their exact application, season, contact, opportunity and version. Thomas's Required path needs current approved food-license evidence; Not Required does not waive insurance. Blank/unknown applicability cannot silently clear the gate. No cross-vendor document or live-admin notice. | **RED** — identity/envelope coverage does not prove native decisions reach the portal. | Connect the native review decision and explicit applicability mapping; capture both vendors and both required/not-required branches with exact final-reservation evidence. |
| L08-4 | Preserve correction and resubmission history | Review version 1, request correction, then submit version 2 before stale work runs. Version 2 becomes current; stale scan/review/outbox work cannot approve or notify for version 1. Keep reason/version history and prove only current approval can unlock the downstream gate. | **RED** — ledger version tests exist; native correction/version flow is unverified. | Implement exact native correction/resubmission and decision mapping, then prove any actual QA correction-email delivery separately. |
| L08-5 | Pressure-test replay, changed payload and stale review | Exact upload-event replay returns the original version; changed content under the same event conflicts. Concurrent ingestion does not duplicate the source. Stale-version, wrong-market and substituted application/document reviews cannot approve another record or send a downstream notice. | **RED** — replay/lease/identity tests are scoped automated evidence. | Run protected ingress and manager/native review against the deployed bridge; capture versions, safe errors, retired jobs and zero wrong-record/provider calls. |

## Release interpretation

These 15 groups are a bounded acceptance plan, not proof that every possible
edge case has been covered. Preserve existing test history with its original
commit and scope. Record current CI results separately from hosted results;
never substitute old aggregate counts or legacy stage receipts for current
field mapping and native evidence.

No row becomes GREEN from a saved environment variable, workflow draft,
database connection, queue entry, or inbox reply alone. No status is promoted
by this documentation update. The L08 bridge, genuine agreement/native events,
current hosted configuration and any unverified notification remain explicit
release gaps. Full payment testing and website routing are separate downstream
acceptance tasks; these L06–L08 cases do not establish production readiness.
