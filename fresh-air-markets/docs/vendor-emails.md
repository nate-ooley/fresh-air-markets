# Emails the portal sends

Every message is sent through Resend from
**Fresh Air Markets <hello@freshairmarketsandevents.com>** (`EMAIL_FROM`).
Replies go to **nateooley68@gmail.com** (`EMAIL_REPLY_TO`). Staff copies go to
**nateooley68@gmail.com** (`STAFF_NOTIFY_EMAIL`). All three are Vercel
Production settings and can be changed without a code change. Each message
ends with "— Fresh Air Markets & Events / (941) 740-8866". Every attempt is
recorded in the `fame_email_log` table with sent/failed and the reason.

Wording lives in `src/lib/email-templates.ts`; triggers in `src/lib/notifications.ts`.

## To vendors

### 1. Application received
**Trigger:** the vendor submits the form at `/apply`.
**Subject:** We received your North Port Farmer's Market application

> Hi {first name},
>
> Thanks for applying to the North Port Farmer's Market with {business name}. Market staff review every application and will reply to this email address with a decision.
>
> If you attached your certificate of insurance (and food license, if you sell food) on the confirmation page, we have it. If not, you can reply to this email with it as a PDF, PNG or JPEG.
>
> If approved, we'll confirm your dates and booth count and send a payment request. Payment is due within 48 hours of that request.

### 2. Application approved
**Trigger:** staff click **Approve** on the application page.
**Subject:** Your North Port Farmer's Market application is approved

> Hi {first name},
>
> Good news: your application for {business name} has been approved.
>
> *If the vendor already uploaded a document:* We have the documents you uploaded with your application. Once market staff have checked them we'll confirm your market dates and booth count and send your payment request.
>
> *Otherwise:* Next step: reply to this email with your certificate of insurance (PDF, PNG or JPEG) and, if you sell food, your food license or permit. Once those are approved we'll confirm your market dates and booth count and send your payment request.

### 3. Changes requested
**Trigger:** staff click **Request changes** and type a reason.
**Subject:** Your North Port Farmer's Market application needs a small change

> Hi {first name},
>
> We reviewed your application and need one thing before we can approve it:
>
> {reason typed by staff}
>
> Reply to this email with the update, or submit the application again with the corrected details.

### 4. Declined
**Trigger:** staff click **Decline** and type a reason.
**Subject:** About your North Port Farmer's Market application

> Hi {first name},
>
> Thank you for applying. We're not able to offer you a booth this season.
>
> {reason typed by staff}
>
> We appreciate your interest and hope to see you at the market.

### 5. Payment request
**Trigger:** staff create the Square checkout and then the private vendor link
(the "Create vendor link" step on the reservation panel).
**Subject:** Payment request: North Port Farmer's Market reservation ($40.00)

> Hi {first name},
>
> Your reservation is ready: {n} booth(s) for {dates}. Total due: {amount}.
>
> Pay securely through Square using your private link: https://freshairmarketsandevents.com/vendor/payment#token=…
>
> This link is only for you and expires {date and time} (Eastern). Unpaid reservations are released after that time. Booth fees are non-refundable.

### 6. Payment received
**Trigger:** Square's webhook confirms the payment (seconds after the vendor pays).
**Subject:** Payment received: North Port Farmer's Market

> Hi {first name},
>
> We received your payment of {amount}. Your booth is confirmed.
>
> You'll receive your booth assignment, market map, and Vendor Pass before your first market day, plus a reminder with setup instructions a few days ahead. Setup begins at 6:30 AM; booths must be ready by 8:00 AM.

## To staff (nateooley68@gmail.com)

| Email | Trigger | Subject |
| --- | --- | --- |
| New application | vendor submits `/apply` | New vendor application: {business} |
| Paid | Square webhook confirms payment | Paid: {business} ($40.00) |
| Website message | visitor uses the contact form | Website message from {name} ({topic}) |
| Password reset | staff use "Forgot your password?" | Reset your Fresh Air Markets & Events staff password |

## Not sent (yet)

No email goes out when a document is approved or rejected, when a reservation
is finalized, when an unpaid hold expires after 48 hours, or as a market-day
reminder. The "payment received" email promises a booth assignment, map,
Vendor Pass and reminder; those are sent by staff today, not by the portal.
