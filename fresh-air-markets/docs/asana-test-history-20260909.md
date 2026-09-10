# Historical Asana testing evidence

Snapshot of the existing launch-testing task before the September 9 headline cleanup. These are historical results with their original scope and dates, not a current launch acceptance claim. Current acceptance is tracked in Linear AUT-4606 and AUT-4596.

CURRENT HEADLINES — September 8, 2026
🟢 Automated code/database checks: 355 isolated + 123 PostgreSQL tests passed; build passed.
🟢 Draft PR pushed; updated Vercel Preview deployment succeeded.
🟢 QA and production application stages saved/reloaded, including Agreement Signed and payment stages; no contacts moved.
🟡 Continuous review/agreement/payment delivery and email timing repaired; hosted workflow acceptance open.
🟡 Payment page, Production Square support and six-worker scheduled recovery implemented; live settings/scheduler disabled.
🔴 Hosted database/private account, booth capacity, document-review bridge, canonical routing, scheduler activation and real Sandbox/native workflow/inbox proof remain open.

Detailed acceptance: https://linear.app/autocraftstudios/issue/AUT-4606
Document flow: https://linear.app/autocraftstudios/issue/AUT-4596
PR: https://github.com/nate-ooley/fresh-air-markets/pull/1
Verified commit: 5d4e5b1
CI: https://github.com/nate-ooley/fresh-air-markets/actions/runs/34308504059
One intentional isolated database placeholder skipped; zero PostgreSQL skips. No live contacts/admins messaged, no real charges or production release. Code/configuration checks do not replace hosted workflow or inbox evidence.

HISTORICAL EVIDENCE (retained)

L06 EXACT-APPLICATION CANDIDATE — September 7, 2026, 15:31–15:53 EDT
Status remains RED; this is a QA candidate, not a production replacement.

Why: the active tracked-link flow selects the most-recent Open opportunity. An opportunity-based trigger can keep the manager's selected application in context instead.

Built and saved QA ONLY - L06 Exact Application Approval:
Workflow f50c1832-349e-4d51-bff1-061e39ff8a8f.
Trigger: Pipeline Stage Changed, QA ONLY - FAME Intake Tests, Approved stage.
Guard: contact email is one of lnooley@gmail.com,nate@autocraftstudios.com AND Application Status is Needs Review AND Opportunity status is open.
Eligible action: dedicated Update Opportunity changes only Application Status to Approved, using the triggering opportunity. There is no Find-most-recent step, message, agreement, SMS, reservation or payment action. None ends.
Re-entry and multiple-opportunity settings are ON for isolated pressure testing. Temporarily published for the test, then restored to Draft. Last observed enrollment count: two historical, zero active.

Observed evidence:
• Nate real stage event entered 15:44:41; eligible branch 15:44:41; exact-opportunity update 15:44:43; End 15:44:44. Reopened QA opportunity 1NdMuEUFi57RvCAUuUsB showed Approved application status with agreement Not Sent and no payment/reservation.
• The intended second replay was logged for Maverick/lnooley at 15:46:35, None → End 15:46:36, with no workflow update. It is NOT counted as a successful Nate replay or cross-application test. Native list ordering changed during save/reopen; the test selection sequence was unreliable. No evidence establishes that the workflow itself selected the wrong opportunity. Future runs must filter to one named QA record and verify the loaded URL, audit ID, contact/email and current values immediately before saving.
• Both QA applications were reset, saved and reopened with visual/identity verification: Open, stage/application Needs Review, agreement Not Sent. Nate date status Not Ready; Maverick date status blank. Existing history retained.

Remaining before production replacement/green:
Prove all five L06 acceptance scenarios with stable selection and actual onboarding receipts; add a current-stage/pipeline recheck for delayed events; verify exact older/current season behavior, signed-in manager authorization/audit and durable message retry recovery. Existing production trigger and emails remain unchanged. L07 real signing and L08 public uploads remain open; public browser policy access is still a blocker.
No new complete 45-scenario pass is claimed. Counts remain 15/45 scoped workflow passes and 12 GREEN / 10 RED / 14 YELLOW.
Owner priority: finish L06–L08, then L17–L19 (Square). Payment information remains pending; no payment tests ran.


AGREEMENT COPY FIX — VERIFIED September 7, 2026, 15:25–15:27 EDT
Added to Section 6 (Setup and Arrival): “Vendors should park behind the sushi restaurant. A golf cart will be available to help transport items.”
Why: these two owner-required provisions were absent from the template. The other three required provisions were already present: standard 10 x 10 space (Section 2), setup one hour before the advertised start (Section 6), and no electricity supplied (Section 8).
Evidence: native editor displayed “Template saved successfully”; template list showed September 7, 03:25 PM; left the editor, reopened template 6a96273acd50c69f00f89464 and visually verified both inserted sentences persisted with the existing clauses.
Result: all five requested copy provisions are now verified in the saved template. The supporting agreement-language task is complete. No existing issued document was regenerated and no agreement was sent or signed. L07 remains RED for actual signing, decline/replay, exact application/document identity and QA notification isolation. This supersedes earlier “wording not saved” notes; retain those as history.

FIX REGISTER — September 7, 2026
Verified fixes and reasons; historical failures are retained in the detailed evidence below. This register does not mark the entire launch or L06–L08 complete.

SAVED HIGHLEVEL CHANGES

1. Email-only vendor flows.
Why: the subaccount is not A2P approved, and the owner requested no SMS.
Fix: removed intake/retired-approval SMS actions and SMS consent blocks from insurance/correction/date forms.
Evidence: nine-workflow configuration review and reopened forms. This is configuration evidence, not proof of every external trigger.

2. One active approval/onboarding route.
Why: multiple approval paths could send duplicate approval emails and agreements.
Fix: consolidated approval, approval email, agreement send and Sent status in Fresh Air Manager Approval; retired the older workflow to Draft.
Evidence: active action sequence tested; retired workflow remained Draft and did not enroll on the tested QA stage change. Rapid-event and complete sole-route proof remain open.

3. Intake finds before creating and preserves review state.
Why: the earlier sequence risked duplicate opportunities, failed status updates and resetting reviewed applications.
Fix: find first, initialize new records to Needs Review, and stop replay from overwriting reviewed states.
Evidence: five scoped native cases cover two vendor mappings, optional blanks, sequential repeat and controlled overlapping entry; production negative check stopped without sending. Public-form concurrency remains open.

4. Approval requires Needs Review (L06).
Why: a reproduced replay resent onboarding for an already Approved application.
Fix: explicit Needs Review condition after a successful lookup, before approval/email/agreement.
Evidence: guarded positives, Approved replay, Declined, Waitlist and Closed/Lost subcases passed in QA; production condition saved/reopened. Production repeat smoke was skipped by re-entry protection, so it did not execute the condition. Exact application identity and manager authorization remain open.

5. Agreement-completion notice follows a valid lookup and repeat guard (L07).
Why: the original admin notice ran before lookup, even when no application could be found.
Fix: Found → not already Signed → Signed update → admin notice; missing/already-Signed branches stop.
Evidence: saved/reopened production configuration; two simulated QA completions and two sequential repeats, with exactly two correctly mapped QA inbox notices. Actual signing events, missing-record runtime proof and delivery recovery remain open.

6. Insurance correction requires Submitted and nonempty notes (L08).
Why: a received correction email had a blank instructions section; stale requests could resend.
Fix: require Submitted plus populated correction notes before update/email.
Evidence: populated-note mappings received correctly; blank-note, repeated-state and missing-opportunity QA stops; saved/reopened production guard and negative smoke passed.

7. Insurance approval requires Submitted (L08).
Why: baseline QA runs approved Not Requested insurance and produced a duplicate approval notice.
Fix: Submitted-only condition before Approved update/email.
Evidence: corrected positive email received; Approved replay and Not Requested stopped; saved/reopened production guard and negative smoke passed. Real certificate validity and document-version identity are unproven.

8. Explicit food-license decision and date-invitation gate.
Why: an unknown food-license requirement must not be treated as satisfied, and later edits must not resend invitations.
Fix: require application Approved, agreement Signed, insurance Approved and food Approved or Not Required, with invitation-state protection.
Evidence: unknown decision blocked; recorded Not Required positive, fourteen negative combinations, required-license positive and sequential repeat checks. Remaining individual blanks and reordered/concurrent real events stay open.

9. Date submission requires an active invitation and Approved application.
Why: a stale/uninvited submission could reset date status or affect an already confirmed application.
Fix: Open opportunity plus Date Selection Sent plus Approved before changing only Dates Submitted.
Evidence: five isolated status cases and a production negative smoke passed. This does not validate actual form dates, quantity or reservation inventory.

10. Calendar, form order and clearer vendor messaging.
Why: the old final-date label was incorrect, quantity was missing, and approval messaging could imply a reservation.
Fix: saved Full Season plus 35 Saturdays, October 3, 2026–May 29, 2027; required final booth quantity; optional phone; Submit after all inputs; approval/insurance wording clarifies that document approval is not a date reservation; approval email includes the insurance-upload link.
Evidence: saved form reopened, selected message mappings/receipts reviewed. Actual quantity/pricing integration, historical reconciliation and all public links remain open.

CODE FIXES — PUSHED IN DRAFT PR #1, NOT MERGED OR DEPLOYED

11. Request validation and abuse controls.
Why: malformed/null JSON and structured or oversized fields could crash routes or reach writes; unlimited submissions enable abuse.
Fix: validate six mutation routes, bounded streaming inquiry bodies, typed/length-bounded vendor and date fields, and shared PostgreSQL rate limits with fail-closed behavior.
Evidence: isolated route/body checks and real database quota/concurrency/expiry tests. Production configuration/migrations remain open.

12. Duplicate inquiry and repeated-approval protection.
Why: double clicks, network retries and reloads could create duplicate applications or repeat CRM sync; late approval could revive a cancelled/rejected booking.
Fix: stable submission keys plus atomic market-scoped receipts; changed payload conflicts; repeated dates rejected; sequential booking approval skips duplicate lifecycle sync; terminal booking states cannot be revived.
Evidence: 100 concurrent retries across two database pools, conflicts, market isolation, rollback, reconnection and preserved reviewed status/price. CRM failure recovery after database commit still needs durable delivery handling.

13. Transactional booth ownership/capacity and schema initialization.
Why: competing approvals must not oversell; cross-market booth use and partially committed date allocations must fail; a bound DDL default broke schema initialization.
Fix: valid schema initialization plus ownership/active-booth checks and locking within transactions.
Evidence: real PostgreSQL tests prove one winner among twenty competing approvals, replay handling, partial-date conflicts, rollback and ownership isolation. Complete Fresh Air quantity/category CHECK/RESERVE integration is unfinished.

14. Consistent portal calendar and session/booking-rule checks.
Why: pages/APIs/selectors must agree on the approved season, prevent invalid date choices and enforce account boundaries.
Fix: shared configured 35-Saturday calendar, all dates accessible in selectors, New York day boundaries, unsupported-season closure and existing session/booking-rule repairs.
Evidence: component/route and isolated rule/session tests; deployed UI/account isolation and production persistence remain unverified.

PREPARED INTEGRATIONS, NOT COMPLETED FIXES
Protected application handoff preserves source snapshots and stable IDs with duplicate-event handling and additive migrations. Square adapter/signature matching and the 48-hour helper are prepared. Neither full CRM/portal reconciliation nor live Square checkout/webhook/expiry integration is complete. No payment test or payment follow-up was run.

CURRENT EVIDENCE AND OPEN ITEMS
PR rechecked: open, draft, unmerged, head 03993108dce4b16daceed4b7b0415cc83b1b2859.
Recorded CI: 78 isolated + 20 real PostgreSQL tests = 98, zero failures, and production build passed.
CI: https://github.com/nate-ooley/fresh-air-markets/actions/runs/34145717005
PR: https://github.com/nate-ooley/fresh-air-markets/pull/1

L06–L08 remain RED. Earlier native audit found two missing agreement provisions; both parking/golf-cart sentences were subsequently saved and reopened on September 7 at 15:25–15:27 EDT, as recorded above. Insurance required-format settings are present; public-file access, size/content validation, correction/resubmission history and exact document identity remain open. Nine synthetic L08 files are prepared locally, not uploaded or counted as tests. After the owner reported access ready, a fresh check of the existing public portal browser tab still failed: admin-enforced policy could not be verified, so access was not granted. No alternate browser or indirect workaround was used. Public signing/upload acceptance remains blocked.

Counts remain 12 GREEN / 10 RED / 14 YELLOW; 15/45 workflow scenarios have scoped passes. QA sends remain restricted to the owner's authorized test addresses; no live contacts/admins, SMS or payment follow-ups. Failed baseline tests remain failures in the audit trail even where corrected retests passed.

Evidence and remaining acceptance:
Asana grid: https://app.asana.com/1/1213438609341517/project/1216402541720351/task/1218219611209298
Workflow evidence: https://app.asana.com/1/1213438609341517/project/1216402541720351/task/1218224152809651
L06: https://app.asana.com/1/1213438609341517/project/1216402541720351/task/1218221971126328
L07: https://app.asana.com/1/1213438609341517/project/1216402541720351/task/1218221021682766
L08: https://app.asana.com/1/1213438609341517/project/1216402541720351/task/1218219611257599


EARLIER GRID AND EVIDENCE

Fresh Air Markets — launch testing grid
Updated September 7, 2026. 36 checks: 12 GREEN / 10 RED / 14 YELLOW. 12 checks verified green; 24 remain unverified or partial. Task checkboxes may include owner-completed setup; colors reflect test evidence. Green applies only to each stated scope; launch is not green.

Latest workflow evidence: 15 of 45 planned pressure checks have scoped QA passes; 30 remain open/partial. W01 now has five native-workflow passes: two distinct vendor mappings, sequential-repeat protection, readable optional blanks and controlled same-contact overlap. Production intake repaired and negative smoke test passed without email. Public-form submission/double-submit remains open. W07 retains 17 isolated execution results, with individual blanks and external event ordering still open. Five green scenarios for every workflow are not yet proven.

Saved fixes: final-date form has Full Season plus 35 unique Saturdays, October 3, 2026–May 29, 2027; Submit below inputs. Production intake now finds before creating, initializes Needs Review on creation and protects existing reviewed states from replay; Thomas routing is preserved. Production insurance correction requires Submitted plus nonempty notes; approval requires Submitted. Both guards were saved/reopened and negative production QA runs stopped without email. The proposed portal now shares the configured 35-Saturday calendar across pages and APIs, with every date reachable in the selectors. Public browser, deployment and persisted calendar alignment remain open.

Last recorded code evidence: 78 isolated tests, twenty real PostgreSQL tests (five each: limiter, application capture, booth bookings and inquiry retry protection) and production build passed in Draft PR #1, GitHub Actions run linked below. These do not prove deployed workflows or a production database integration.

ID   | RESULT    | CHECK
-----+-----------+--------------------------------------------------------------
G01  | 🟢 GREEN   | Email-only vendor workflow configuration
G02  | 🟢 GREEN   | Saved vendor form configuration and Submit order
G03  | 🟢 GREEN   | Intake lookup, status update and QA admin notification
G04  | 🟢 GREEN   | Manager approval action sequence
G05  | 🟢 GREEN   | Unknown food-license decision blocks final dates
G06  | 🟢 GREEN   | Complete documents with food license not required send invitation
G07  | 🟢 GREEN   | Later edits do not resend the date invitation
G08  | 🟢 GREEN   | Insurance correction action sequence and email
G09  | 🟢 GREEN   | Insurance approval after correction
G10  | 🟢 GREEN   | 78 isolated tests + 20 PostgreSQL tests
G11  | 🟢 GREEN   | Production build of proposed code
G12  | 🟢 GREEN   | QA records are clearly labeled and simulated approvals reset
L01  | 🔴 RED     | Restore public browser testing access
L02  | 🟡 YELLOW  | Apply the confirmed season calendar everywhere
L03  | 🟡 YELLOW  | Preserve existing applicants and verify production handoff
L04  | 🔴 RED     | Public application validation and duplicate submission
L05  | 🟡 YELLOW  | Verify admin and vendor inbox routing and all links
L06  | 🔴 RED     | Approval trigger link, replay and missing opportunity
L07  | 🔴 RED     | Agreement signing, declined signing and completion replay
L08  | 🔴 RED     | Insurance upload validation, correction and resubmission
L09  | 🟡 YELLOW  | Food-license request, upload, correction and approval
L10  | 🟡 YELLOW  | Live negative document gates and required-license positive path
L11  | 🟡 YELLOW  | Declined and waitlisted vendors cannot reserve or pay
L12  | 🔴 RED     | Final-date form validation and repeated submission
L13  | 🟡 YELLOW  | Static instructions and real policy links
L14  | 🟡 YELLOW  | Live per-booth pricing across calendar boundaries
L15  | 🟡 YELLOW  | Capacity boundaries and partial availability
L16  | 🟡 YELLOW  | Availability check through manager review and atomic reservation
L17  | 🔴 RED     | Connect the correct Square account and sandbox
L18  | 🔴 RED     | Square successful, declined, cancelled and retried checkout
L19  | 🔴 RED     | Payment webhook replay, order and authenticity
L20  | 🟡 YELLOW  | Nonprofit zero-dollar reservation
L21  | 🟡 YELLOW  | Payment deadline, expiry and manual exception behavior
L22  | 🟡 YELLOW  | Real PostgreSQL concurrency, rollback and recovery
L23  | 🟡 YELLOW  | Deployed authentication and tenant isolation
L24  | 🔴 RED     | Final deployed vendor journeys and launch reconciliation

Additional verified receipt check: Nate Outlook contains exactly the two expected [QA W01-R2] intake emails, with no CC/BCC or repeated notices. Native HighLevel access restored. Final guarded approval and sequential replay now passed; QA records reset, QA workflow Draft with zero active.

Public inquiry rate limiting and bounded streaming bodies are implemented/tested in the draft PR; production migration and deployment verification remain open. The twenty PostgreSQL checks cover limiter boundaries, application capture, existing booth booking transactions and inquiry retry protection. Booking checks verify competing approvals, replay, partial-date conflicts, cancellation, market ownership and rollback/reconnection. Complete quantity/category CHECK/RESERVE and deployed recovery remain open. Workflow matrix is 15/45; the two new passes cover native approval and sequential replay.

Confirmed scope: email-only workflows; authorized QA recipients only, with Nate Outlook serving as vendor/admin receipt verification. No live-contact/admin test sends or payment/follow-up tests. Thomas decides food-license applicability; payment window 48 hours. Preserve existing applicants and history. Square integration testing remains excluded pending setup.

Open dependencies include Vercel connector authorization (403 at the exact project URL), public browser policy verification, real policy URLs, actual document upload/signing, CRM/database/portal integration and deployed end-to-end verification. No production merge/deployment or Square charge is claimed.

45-scenario evidence: https://app.asana.com/1/1213438609341517/project/1216402541720351/task/1218224152809651
Document-gate grid: https://app.asana.com/1/1213438609341517/project/1216402541720351/task/1218224145471557
Build requirements: https://app.asana.com/1/1213438609341517/project/1216402541720351/task/1218221974113174
PR: https://github.com/nate-ooley/fresh-air-markets/pull/1
CI: https://github.com/nate-ooley/fresh-air-markets/actions/runs/34145717005
Linear: https://linear.app/autocraftstudios/issue/AUT-4591/fresh-air-markets-launch-testing-checklist-36-checks

Asana and Linear are linked snapshots, not automatic synchronization.

W02 current summary: Two final guarded positive runs completed in 10–12 seconds. Nate approval/agreement verified in Outlook; second-vendor mapping and provider delivery verified, inbox placement unverified. Approved, Declined, Waitlist and Closed/Lost negative cases stopped. Production Needs Review condition saved/reopened; production smoke Skipped by existing re-entry setting. Wrong/older identity, actual approval link and overlap remain open, so L06 stays RED. Agreements unsigned; L07 remains RED. Detailed evidence is in the 45-scenario matrix. QA Draft, re-entry OFF, 10 historical/zero active, both QA records reset.

W03 latest: agreement admin notice moved after application lookup and Signed update; already-Signed guard saved/reopened. Four isolated native executions (two simulated completions and two sequential replays) passed. Exactly two mapped QA admin emails verified in Nate Outlook; no duplicate on replay. Actual signature and document-event validation remain red. QA copy Draft, 4 historical/0 active; both QA agreement fields reset/reopened Not Sent. Counts unchanged.

Portal repair September 7: double-click/reload/network retry identity and atomic submission receipts are implemented and tested in commit 03993108dce4b16daceed4b7b0415cc83b1b2859. The 100-request PostgreSQL race produced one application; conflicting payloads, tenant isolation, rollback and preserved reviewed history also passed. Duplicate dates are rejected; confirmation copy is email-only. L04/L12 remain RED for deployed public/source-form verification and final reservation integration. Migration 003 plus coordinated form/API release and durable CRM recovery are still required. This does not increase the separate 15/45 native workflow count.

W08 date-status repair — September 7, 2026
CASE | STATUS | VERIFIED RESULT
Valid invitation | 🟢 GREEN | Correct QA application → Dates Submitted
Sequential repeat | 🟢 GREEN | None/End, no update
Confirmed state | 🟢 GREEN | Confirmed status retained
Not Ready | 🟢 GREEN | None/End, no update
Declined + old invitation | 🟢 GREEN | None/End, no update
Production QA negative | 🟢 GREEN | Correct existing QA application found, None/End
Actual dates/quantity/reservation journey | 🔴 RED | Still unverified
Blank-state setup | 🔴 RED | Native cleared value did not persist

Production guard saved/reopened Published: Open application, Date Selection Sent AND Approved required. Five QA branch cases and one production Nate-only negative passed. QA Draft, 5/0; production Published, 1/0. L12 stays RED: actual form/date/quantity/reservation journey, blank state, identity and concurrency remain open. Matrix stays15/45; launch grid12 GREEN /10 RED /14 YELLOW.
