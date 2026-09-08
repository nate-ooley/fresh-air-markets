# Square Sandbox setup and verification

This runbook connects the new **Farmers Market Vendor Portal** Square
application to the portal's QA deployment. It creates no real payment,
does not send email, and does not create a webhook subscription until the
durable payment and webhook work is deployed.

Square provisions an isolated Sandbox when an application is registered in the
Developer Console. Use the new application's **Sandbox** toggle throughout
this runbook. Sandbox tokens and test payment values cannot affect the
production Square account.

## 1. Gather the two initial Sandbox values

In [Square Developer Console](https://developer.squareup.com/apps), open
**Farmers Market Vendor Portal**, select **Sandbox**, then open
**Locations** and select the active **Default Test Account**. Collect:

| Square screen | Portal variable | Notes |
| --- | --- | --- |
| **Credentials** → Sandbox Access Token | `SQUARE_ACCESS_TOKEN` | Secret; choose **Show** only long enough to copy it. |
| **Locations** → Default Test Account → Sandbox location | `SQUARE_LOCATION_ID` | Copy the active location ID, not the location name. It must belong to the same Sandbox test account as the token. |

Do not enter a Square website username or password in Vercel. A Sandbox access
token is the server credential. Square's [access-token guide](https://developer.squareup.com/docs/build-basics/access-tokens)
and [Sandbox overview](https://developer.squareup.com/docs/devtools/sandbox/overview)
describe these values.

## 2. Add the initial variables to the QA Preview branch

In **Vercel → Farmers Market → Settings → Environment Variables**, create these
Square variables with the **Preview** environment selected. Scope them to the
`codex/vendor-booking-validation` branch when that branch selector is
available. Do not add them to **Production** or prefix them `NEXT_PUBLIC_`.

Before adding a Preview-only QA fault control, enable **Automatically expose
System Environment Variables** for this Vercel project. The server and local
signer require Vercel to provide `VERCEL=1` and `VERCEL_ENV=preview`; without
that setting they intentionally refuse every QA mode rather than risk a
Production-like deployment.

The deployed checkout, webhook, and expiry routes use the same Preview/Sandbox
gate. They require `VERCEL=1`, `VERCEL_ENV=preview`,
`SQUARE_ENVIRONMENT=sandbox`, and the exact value
`SQUARE_ALLOW_LIVE_PAYMENTS=false`. Do not create `VERCEL` or `VERCEL_ENV`
yourself; Vercel supplies them to a Preview deployment after system variables
are enabled. The read-only verifier below intentionally does not require these
runtime markers, so it can run locally through `vercel env run`.

Before testing checkout, confirm that this same Preview branch already has a
QA-only `DATABASE_URL`, a private `AUTH_SECRET`, and a signed-in QA manager
account for the same market. Those are existing portal prerequisites, not
Square credentials. Do not point the QA Preview at a live database or reuse a
Production authentication secret.

| Variable | Value | Vercel handling |
| --- | --- | --- |
| `SQUARE_ENVIRONMENT` | `sandbox` | Preview branch only |
| `SQUARE_ALLOW_LIVE_PAYMENTS` | Exact lower-case `false` | Preview branch only; any other or missing value fails closed |
| `SQUARE_ACCESS_TOKEN` | Square Sandbox Access Token | Mark sensitive; Preview branch only |
| `SQUARE_LOCATION_ID` | Square Sandbox Location ID | Preview branch only |

The same QA Preview also needs these existing server-only portal values before
checkout, webhook, or expiry testing. Do not substitute a HighLevel location
for `FAME_MARKET_ACCOUNT_ID`, and do not point any one of these settings at
Production.

| Variable | QA requirement |
| --- | --- |
| `DATABASE_URL` | Isolated QA portal database with the full migration sequence applied |
| `AUTH_SECRET` | Private QA authentication secret and a signed-in QA manager |
| `FAME_MARKET_ACCOUNT_ID` | Existing portal account ID for the QA market |
| `FAME_SEASON_ID` | Confirmed QA season (`2026-2027`) |
| `FAME_BOOTH_CAPACITY` | Approved whole-number market-wide capacity; no fallback |
| `CRON_SECRET` | Private random 32+ character secret for the authenticated expiry route |

Leave these blank at this stage:

- `SQUARE_MERCHANT_ID` — optional mismatch guard, never required for initial
  setup or checkout. The verified merchant identity is stored with the payment
  order.
- `SQUARE_WEBHOOK_URL` and `SQUARE_WEBHOOK_SIGNATURE_KEY` — they are added
  only when the webhook route is deployed and subscribed.

Vercel applies a changed value only to a new deployment. Create or redeploy a
Preview after saving the variables. Vercel's [environment-variable guide](https://vercel.com/docs/environment-variables)
explains Preview branch scoping.

## 3. Verify the Sandbox identity without creating a payment

From the checked-out portal branch after it is linked to the Farmers Market
Vercel project, run this one read-only command:

```bash
vercel env run -e preview --git-branch codex/vendor-booking-validation -- npm run square:verify-sandbox
```

If the variables are scoped to every Preview branch instead, omit the
`--git-branch` option. The command prints only the verified merchant and
location IDs; it never prints the token or provider response body.

The checkout must have the Vercel CLI installed and linked once to the
**Farmers Market** project (`vercel link`) before this command can load the
Preview variables. It does not need a Square username or password.

It makes exactly two Sandbox reads:

1. `GET /v2/merchants` retrieves the sole merchant selected by the stored token.
2. `GET /v2/locations/{SQUARE_LOCATION_ID}` confirms the configured active
   location is owned by that active merchant.

The command stops for an invalid token, a malformed provider response, an
inactive location, or a token/location merchant mismatch. If an operator later
sets `SQUARE_MERCHANT_ID`, it must exactly equal the verified result or the
same guard stops configuration. Square documents that a merchant ID is
available only through the [Merchants API](https://developer.squareup.com/docs/merchants-api),
while the location's `merchant_id` establishes the ownership check in the
[Locations API](https://developer.squareup.com/docs/locations-api).

The verifier has no public HTTP route. It is a local, server-only command run
with Vercel-injected Preview variables.

## 4. Enable the payment path only after its persistence migration is deployed

The payment worker uses the verified merchant identity together with the exact
Sandbox location, reservation revision, amount and Square order ID. Apply the
payment-order migration and deploy the payment worker before it creates a
hosted payment link. A browser return URL is not payment confirmation.

Keep `SQUARE_ENVIRONMENT=sandbox` and `SQUARE_ALLOW_LIVE_PAYMENTS=false` for
every QA run. Do not reuse a Sandbox token, location, merchant, webhook key or
webhook subscription in Production.

## 5. Create the Sandbox webhook subscription without opening the Preview

Complete this section only after the migration order in
[square-checkout-ledger.md](./square-checkout-ledger.md) has been applied to
the QA database: the portal chain through `010`, then
`011-square-payment-checkout-ledger.sql`, `012-square-webhook-events.sql`,
`013-final-reservation-writer.sql`, `014-square-payment-expiry.sql`, and
`015-square-payment-expiry-retry-schedule.sql`. The Preview deployment must contain
the durable final-reservation and webhook handlers, and the exact URL must be
reachable over HTTPS.

The current QA Preview is protected by Vercel Authentication. Keep that
protection enabled. A Square webhook cannot sign in through Vercel, so use
Vercel's **Protection Bypass for Automation** for this one external endpoint
instead of sharing the Preview or disabling its protection. The bypass value is
an external secret: never add it to source, GitHub, Asana, Linear, a browser
recording, or chat.

The bypass is a broad capability for protected deployments in the Vercel QA
project, not a route-specific exception. Use a dedicated QA-only bypass in a
project that carries no Production configuration. Rotate or revoke it after the
QA run, then replace the affected QA webhook URL and Sandbox subscription
before any later run. Never use a Production bypass in this process.

1. In **Vercel → Farmers Market → Settings → Deployment Protection**, create a
   dedicated QA **Protection Bypass for Automation** secret. Leave Vercel
   Authentication enabled for the Preview.
2. Build the destination from the stable QA branch alias:
   `https://farmers-market-git-codex-1670af-nateooley68-gmailcoms-projects.vercel.app/api/payments/square/webhook?x-vercel-protection-bypass=<Vercel-automation-secret>`.
   Confirm the alias still resolves to the current QA branch before using it.
3. Set that exact full destination as the **sensitive** `SQUARE_WEBHOOK_URL`
   value in the same Preview branch. The Square subscription must use the exact
   same string, including the query value: Square signs the configured
   notification URL. Do not register a placeholder, a changing deployment URL,
   or a URL without the protection bypass.
4. In Square Developer Console, keep **Sandbox** selected and open
   **Webhooks → Subscriptions → Add subscription**.
5. Name it `Farmers Market QA payments`, choose the current Square API version,
   paste the exact `SQUARE_WEBHOOK_URL`, and select `payment.created` and
   `payment.updated`.
6. Save the subscription. Open **Endpoint details → Signature key → Show**,
   then add the generated value as the sensitive Preview-only
   `SQUARE_WEBHOOK_SIGNATURE_KEY` value.
7. Redeploy the Preview so the URL and signature key are loaded together, then
   send a Sandbox payment event and capture the durable receipt and exact order
   match.

The route verifies the raw body against the configured URL before JSON parsing,
then deduplicates the event and matches merchant, location, order, amount and
currency before payment state changes. It must respond quickly with a `2xx`
only after its receipt path succeeds. Square's [webhook overview](https://developer.squareup.com/docs/webhooks/overview)
and [subscription guide](https://developer.squareup.com/docs/webhooks/step2subscribe)
cover the Developer Console steps.

Vercel documents the automation-bypass query method for third-party webhooks
in its [Deployment Protection guide](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation).

## 6. Run controlled Preview-only negative paths

The checked-in QA support has no public route and never receives a mode from a
browser request. It is enabled only when Vercel's system variables report
`VERCEL=1` and `VERCEL_ENV=preview`, while
`SQUARE_ENVIRONMENT=sandbox` and `SQUARE_ALLOW_LIVE_PAYMENTS=false`. If any
`SQUARE_QA_*` value appears outside that exact environment, the affected route
fails closed. Never add these values to Production.

Create a new random, 32-character-or-longer `SQUARE_QA_SIGNER_SECRET` only in
the QA Preview environment. It authorizes the local replay command's custom
header; it is separate from Square's webhook signature key and must never be
put in a browser, ticket, recording, or chat.

Arm only one fault at a time, always against a newly labeled `QA-SQ-*` record,
then remove every `SQUARE_QA_*` value and redeploy before the next case. The
configuration rejects mixed targets:

| Test path | Required values | Synthetic behavior |
| --- | --- | --- |
| Checkout | `SQUARE_QA_FAULT_MODE` plus one exact `SQUARE_QA_FAULT_RESERVATION_ID` | `checkout_429`, `checkout_500`, `checkout_timeout`, `checkout_permanent_400`, or `checkout_expired_link`; replaces only that checkout provider transport and makes no Square checkout API call. Other checkout IDs are blocked while it is armed. |
| Expiry | `SQUARE_QA_FAULT_MODE` plus one exact `SQUARE_QA_FAULT_PAYMENT_ORDER_ID` | `expiry_429`, `expiry_500`, `expiry_timeout`, `expiry_link_mismatch`, `expiry_cancelled_order_mismatch`, `expiry_cancelled_order_missing`, `expiry_missing_link_open`, or `expiry_missing_link_completed`; replaces only retirement-provider calls for the target order and makes no Square API call. The expiry worker scans only that payment order. |
| Webhook rollback | `SQUARE_QA_FAULT_MODE=webhook_rollback`, one exact `SQUARE_QA_FAULT_EVENT_ID`, and `SQUARE_QA_SIGNER_SECRET` | Only a locally signed matching event reaches the injected rollback. It throws after the paid mutations but before commit, so the route returns `503` and the receipt, order, and reservation all roll back. |

The normal read-only Sandbox identity preflight still runs for checkout and
expiry. For the expiry route, invoke the protected stable QA Preview URL with
both its dedicated `x-vercel-protection-bypass` query capability and
`Authorization: Bearer <CRON_SECRET>`; see
[square-payment-expiry.md](./square-payment-expiry.md). The bypass is broad to
the QA Vercel project, so do not reuse it outside this dedicated QA run and
rotate or revoke it when QA ends.

Create deterministic local webhook bodies with the no-network
[`scripts/generate-square-qa-webhook-fixture.mjs`](../scripts/generate-square-qa-webhook-fixture.mjs)
helper before dispatching them. It supports `valid`, `malformed`,
`wrong-identity`, `late`, `failed`, and `out-of-order` cases, writes a new
local file with restricted permissions, and never reads credentials, signs a
webhook, or calls Square. Supply only IDs and cents from the isolated labeled
QA record; never put the resulting file in source control or a work item.

```bash
npm run square:qa-webhook-fixture -- --case valid --out /secure/qa-event.json \
  --merchant-id <qa-merchant-id> --location-id <qa-location-id> \
  --order-id <qa-square-order-id> --payment-id <qa-payment-id> --amount-cents <qa-cents>
```

Run the local dispatcher through the linked Vercel CLI so it has the same
private Preview variables and exposed Vercel system variables above. If the
variables are scoped to every Preview branch, omit `--git-branch`. It refuses
every other environment and succeeds only when the HTTP status **and exact app
JSON response** match the requested case; a Vercel authentication page or
proxy `401` is a failed test, not route evidence:

```bash
vercel env run -e preview --git-branch codex/vendor-booking-validation -- \
  npm run square:qa-webhook -- --ack-preview-sandbox --expect paid --body-file /secure/qa-event.json
```

Reuse the exact same local file for a duplicate replay. Use `--invalid-hmac`
for the unauthenticated case and `--oversized` for the 128-KiB boundary; those
negative probes select and verify their own expected app responses. The dispatcher
never prints its URL, payload, webhook key, Vercel bypass, or QA signer secret.
Keep each fixture local; it is not a production payment record and must use
only the isolated QA reservation.

## Current release conditions

The Sandbox credential setup alone does not make L17–L19 green. Before a
payment flow can be marked green, the QA deployment needs the reviewed database
migrations, the exact payment-order and webhook ledger, a protected stable HTTPS
QA endpoint reachable only with the dedicated automation bypass, the five
required QA cases, and evidence that no live contact or administrator received
a test action.
