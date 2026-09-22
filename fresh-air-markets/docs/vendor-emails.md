# Emails the portal sends

Every message is sent through Resend from
**Fresh Air Markets <hello@freshairmarketsandevents.com>** (`EMAIL_FROM`).
Replies go to **nateooley68@gmail.com** (`EMAIL_REPLY_TO`). `hello@freshairmarketsandevents.com` is a send-only identity: the domain's mail is hosted at Microsoft 365 and no such mailbox exists there, so replies to it bounce ("Message blocked"). Point `EMAIL_REPLY_TO` at a mailbox someone reads, or create hello@ in Microsoft 365 first. Staff copies go to
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
> If you didn't attach your certificate of insurance (and food license, if you sell food) on the confirmation page: Upload it here (PDF, PNG or JPEG; the link works for 14 days): https://freshairmarketsandevents.com/apply/documents#token=…
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
> *Otherwise:* Next step: we need your certificate of insurance and, if you sell food, your food license or permit. Upload it here (PDF, PNG or JPEG; the link works for 14 days): https://freshairmarketsandevents.com/apply/documents#token=…
>
> Once those are approved we'll confirm your market dates and booth count and send your payment request.

### 3. Changes requested
**Trigger:** staff click **Request changes** and type a reason.
**Subject:** Your North Port Farmer's Market application needs a small change

> Hi {first name},
>
> We reviewed your application and need one thing before we can approve it:
>
> {reason typed by staff}
>
> If it's a document (certificate of insurance, food license), upload it here; the link works for 14 days: https://freshairmarketsandevents.com/apply/documents#token=…
>
> If it's a detail on the application, submit the application again with the corrected details, or reply to this email.

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
>
> Want more Saturdays this season? Pick them here and we'll send a payment link; your insurance and agreement stay on file: {book more dates link}

### 7. Booking withdrawn
**Trigger:** staff press "Withdraw this booking" on an unpaid booking (held, awaiting payment or expired; a booking waiting on manager review must be settled first). Square must confirm the payment link is cancelled before the dates are released.
**Subject:** Booking withdrawn: North Port Farmer's Market

> Hi {first name},
>
> As requested, we've withdrawn your booking for {dates}. No payment is due for these dates and any earlier payment link no longer works.
>
> {staff note}
>
> Your application stays on file for the season. To book different dates, choose them here and we'll send a new payment link: {book more dates link}

### 8. Application withdrawn
**Trigger:** staff press "Withdraw this application" on the application page. Every unpaid booking is withdrawn first; a paid booking blocks it until refunded in Square.
**Subject:** Application withdrawn: North Port Farmer's Market

> Hi {first name},
>
> As requested, we've withdrawn {business name}'s application for this season. Any unpaid booking and payment link have been cancelled.
>
> {staff note}
>
> If this was a mistake or you change your mind, reply to this email or call us and we'll get you back in.

### 9. Date request received
**Trigger:** the vendor sends a "book more dates" request from their personal link (`/vendor/book`, in the payment-received and booking-withdrawn emails; link works 120 days). Staff get "Date request: {business}" at the same time.
**Subject:** We got your date request: North Port Farmer's Market

> Hi {first name},
>
> Thanks! You asked for {n} booth(s) on {dates}.
>
> Market staff will confirm the dates and email you a secure Square payment link, usually within a day or two. Once confirmed, your dates are held for 48 hours and released if the link isn't used in time.

Confirming the request sends the normal **Payment request** email (5). Declining sends:

### 10. Date request declined
**Subject:** About your date request: North Port Farmer's Market

> Hi {first name},
>
> We couldn't confirm your request for {dates}.
>
> {staff note}
>
> Want more Saturdays this season? Pick them here and we'll send a payment link; your insurance and agreement stay on file: {book more dates link}

### 0. Finish your application (invitation)
**Trigger:** the owner sends a pre-filled application link (used for vendors who applied through the old HighLevel forms).
**Subject:** Finish your North Port Farmer's Market vendor application

> Hi {first name},
>
> Thanks for your interest in the North Port Farmer's Market with {business name}. We've moved vendor applications to our new website, and we need a few things from you to hold your spot.
>
> Use this personal link to finish your application. Your details and the dates you asked for ({dates or "the full season"}) are already filled in: https://freshairmarketsandevents.com/apply#prefill=…
>
> Please check your details, choose how many booths you need, sign the vendor agreement, and attach your certificate of insurance (PDF, PNG or JPEG). It takes about two minutes.
>
> Once market staff approve your application, we'll confirm your dates and email you a secure Square payment link. Payment is due within 48 hours of that email.

## To staff (nateooley68@gmail.com)

| Email | Trigger | Subject |
| --- | --- | --- |
| New application (includes vendor email and phone) | vendor submits `/apply` | New vendor application: {business} |
| Paid | Square webhook confirms payment | Paid: {business} ($40.00) |
| Website message | visitor uses the contact form | Website message from {name} ({topic}) |
| Password reset | staff use "Forgot your password?" | Reset your Fresh Air Markets & Events staff password |
| Staff invitation (to the invitee) | owner invites a manager on `/staff` | You're invited to manage {market} on Fresh Air Markets |
| Date request | vendor sends a "book more dates" request | Date request: {business} ({n} Saturdays) |

## Not sent (yet)

No email goes out when a document is approved or rejected, when a reservation
is finalized, when an unpaid hold expires after 48 hours, or as a market-day
reminder. The "payment received" email promises a booth assignment, map,
Vendor Pass and reminder; those are sent by staff today, not by the portal.
