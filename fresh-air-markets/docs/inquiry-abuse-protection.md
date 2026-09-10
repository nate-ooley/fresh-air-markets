# Public inquiry abuse protection

The public inquiry endpoint limits requests before any booking creation or
HighLevel synchronization. This does not replace application deduplication,
authentication, edge DDoS protection or document/booking review gates.

## Policy

- At most 20 attempts per client IP per 10-minute window across inquiry markets.
  Invalid bodies and unknown markets consume this quota too.
- At most 5 otherwise valid attempts per normalized email and market per hour.
  The email is unverified, so this is an additional abuse brake, not identity proof.
- Windows start with the first attempt. Blocked attempts do not extend them.
- A blocked request returns 429, a positive Retry-After value and no-store.
- A missing/unavailable shared limiter returns 503 before booking or CRM writes.
- Actual request bodies are limited to 32 KiB, including chunked input or a false
  Content-Length. Oversized bodies return 413 and their reader is cancelled.

The policy constants are in src/lib/inquiry-rate-limit.ts. Review these defaults
against real traffic, including shared networks, before launch; adjust limits in
code with regression tests. These limits intentionally do not promise protection
against a distributed botnet or prevent every form of targeted denial of service.

## Deployment

1. Apply docs/migrations/002-inquiry-rate-limit.sql to the intended PostgreSQL
   database before deploying the route. It adds only a rate-limit table/index.
2. Configure DATABASE_URL and a private AUTH_SECRET of at least 32 characters.
   Counters store HMAC digests, not raw email/IP addresses. Secret rotation resets
   the effective key space and should be coordinated with the rate-limit window.
3. Production always uses shared PostgreSQL counters. There is no per-instance
   memory fallback on configuration/database failure. A production demo without
   a database can still display the site, but inquiry writes return 503.
4. On Vercel, trust only its overwritten x-forwarded-for header, and only when
   the server-side VERCEL environment variable is 1. Invalid/multi-IP values fall
   into one conservative unknown-client bucket. Self-hosted deployments ignore
   forwarded headers and share that bucket until a trusted proxy adapter exists.
   Do not set VERCEL=1 manually on an untrusted/self-hosted deployment.
5. Schedule the migration's expired-bucket cleanup query daily in database
   maintenance. Never delete active buckets. Monitor 429/503 counts, counter-table
   growth and shared database load. Configure edge abuse protection separately.
6. Verify deployed client-header behavior, shared-network limits, 429/Retry-After,
   503 behavior, migration access and zero CRM side effects before launch.

The atomic UPSERT uses the database clock and shared unique bucket keys; different
server connections cannot independently allocate a full quota. The blocked hit
counter saturates at limit+1. Database maintenance and Vercel configuration have
not been applied by this code change.

## Verification

npm test runs the isolated route/body/identity/memory tests with CRM doubles.
npm run test:pg runs five real PostgreSQL cases after npm test compiles the code.
The integration suite refuses any URL except localhost/127.0.0.1 with database
name fresh_air_test. GitHub Actions provisions that disposable service without
production credentials. It covers 100 concurrent requests across two pools,
independent keys, expiry, non-extending blocked retries and a new client connection.
This is database implementation evidence, not proof of production deployment.

Primary references:
- https://vercel.com/docs/headers/request-headers (Vercel overwrites X-Forwarded-For)
- https://www.postgresql.org/docs/current/sql-insert.html (atomic ON CONFLICT DO UPDATE)
