# Production payment recovery scheduler

The `.github/workflows/payment-scheduler.yml` workflow calls six authenticated workers from one standard GitHub-hosted runner. It is disabled unless the repository variable `FAME_PAYMENT_SCHEDULER_ENABLED` is exactly `true`. Manual `workflow_dispatch` uses the same gate. Adding or deploying this code does not enable the scheduler.

The caller is fixed to `https://freshairmarketsandevents.com`; repository variables, query parameters, workflow inputs and provider responses cannot redirect it. These paths must already route to the released backend and return authenticated JSON on that exact domain:

1. `/api/internal/cron/application-review-outbox` — failed review delivery recovery.
2. `/api/internal/cron/agreement-completion-stage-outbox` — Signed agreement-field recovery.
3. `/api/internal/cron/payment-pending-sync` — set the exact signed, payable application's Vendor Payment Status to Ready for Payment.
4. `/api/internal/cron/payment-email` — submission recovery and provider receipt polling.
5. `/api/internal/cron/payment-paid-sync` — exact paid-state HighLevel sync.
6. `/api/internal/cron/square-payment-expiry` — due holds and Square link retirement.

This order lets earlier application and agreement deliveries become prerequisites for later payment work in the same run. Readiness sync waits for the exact Signed agreement-field receipt; it does not replace or manually move an opportunity to bypass that requirement. The pending worker uses `GHL_PAYMENT_SYNC_ENABLED`, like paid-field sync, and handles at most one job per invocation. Creating checkout only queues readiness-field work; this batch adds no immediate provider dispatch to checkout creation.

Each GET requires the shared `Authorization: Bearer <CRON_SECRET>` header. The script refuses missing, short or malformed secrets. It follows no redirects, invokes workers sequentially, and gives each request a 55-second deadline: all six requests are bounded to under six minutes, excluding runner setup. One worker failure does not skip the others. Output contains only worker names, bounded integer counts, HTTP status codes and fixed error codes. Secrets, authorization headers, raw response bodies, vendor identities and invitation URLs are never printed.

HTTP/transport/invalid-response failures and returned permanent-failure/manual-review/uncertain/stale counts make the workflow fail. A successful response with a scheduled retry is reported through its counts; the next run respects each worker's persisted retry time. The caller does not retry a request in the same run. The workers retain their own leases, idempotency and no-duplicate-send protections.

## Exact setup after QA and production approval

Do not enable this workflow until the production release, domain routing, private database, Square identity/webhook, and HighLevel status-field/email routing have passed acceptance. Production HighLevel settings must use the live pipeline and approved recipients, without QA flags. This scheduler's enable flag does not bypass any worker's configuration checks.

In the `nate-ooley/fresh-air-markets` GitHub repository:

1. Open **Settings → Secrets and variables → Actions → Secrets**. Add repository secret **`CRON_SECRET`** with the same value stored under **`CRON_SECRET`** in the Farmers Market Vercel project's **Production** environment. Use at least 32 characters. Enter it directly into the secret boxes; do not put it in an issue, source file, command, or chat.
2. Confirm all six fixed-domain paths reach the released backend. A marketing HTML page, redirect, disabled worker or authentication failure will produce a failed scheduler run.
3. Open **Settings → Secrets and variables → Actions → Variables**. Add repository variable **`FAME_PAYMENT_SCHEDULER_ENABLED`** with value **`true`** only after production approval. Keep it unset or `false` until then.
4. After the approved workflow exists on the default branch, use **Actions → Fresh Air payment recovery → Run workflow** for the first observed run. Review aggregate results and exact database/provider evidence. Configure the owner's GitHub failed-workflow notifications and monitor future failures.
5. To stop recovery calls, set the variable to `false`. This stops new worker invocations; it does not undo already accepted emails, completed payments, or in-flight requests.

The schedule requests runs every five minutes at minutes 2, 7, 12, …, 57. It avoids the top of the hour but is **best effort**: GitHub may delay or drop scheduled runs. Scheduled workflows run only from the default branch; public-repository schedules can be disabled after 60 days without repository activity. Check the Actions page before each season and monitor failures. The 48-hour payment deadline remains the persisted application deadline; scheduling delay does not extend it, and capacity stays held until the worker confirms the Square link is retired.

Vercel Hobby's built-in cron cadence is daily, so it cannot provide this recovery frequency. The existing public repository can use standard GitHub-hosted runners without paid runner minutes, subject to platform limits. No account plan has been changed by this implementation.

Official references: [GitHub scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

## Verification scope

Accelerated QA may invoke the protected workers manually against the verified Preview deployment in the same order, using the Preview cron secret injected privately. This does not enable the fixed Production scheduler or shorten the vendor's persisted 48-hour deadline. The worker still honors durable prerequisites and retry times; never edit provider stages or database receipts merely to make a test pass. Preview contact and routing guards remain required, with no live contact/admin messages or SMS.

Injected-transport tests exercise fixed origins, authentication headers, disabled configuration, sequential execution, bounded response parsing, continuing after failures, sanitized output and nonzero failure exit status without contacting any service. They do not prove domain routing, scheduler activation, hosted worker operation, Square payment acceptance or inbox delivery. Those remain deployment acceptance checks.
