import { pathToFileURL } from 'node:url';

// No path is ever supplied by an event, caller, or response. The origin is the
// vendor portal origin when the repository variable names an allowed host (the
// market domain, one of its subdomains, or the Vercel deployment host); any
// other value falls back to the market website.
export const PAYMENT_SCHEDULER_ORIGIN = 'https://freshairmarketsandevents.com';
export function paymentSchedulerOrigin(env = process.env) {
  try {
    const url = new URL(env.FAME_VENDOR_PORTAL_ORIGIN ?? '');
    const host = url.hostname.toLowerCase();
    const allowed = host === 'freshairmarketsandevents.com' || host.endsWith('.freshairmarketsandevents.com') || host.endsWith('.vercel.app');
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && url.pathname === '/'
      && !url.search && !url.hash && allowed) return url.origin;
  } catch { /* fall through to the default origin */ }
  return PAYMENT_SCHEDULER_ORIGIN;
}
const TIMEOUT_MS = 55_000;
const MAX_RESPONSE_BYTES = 4096;
const WORKERS = Object.freeze([
  { name: 'application_review', path: '/api/internal/cron/application-review-outbox', keys: ['delivered', 'deferred', 'failed', 'stale'] },
  { name: 'agreement_completion', path: '/api/internal/cron/agreement-completion-stage-outbox', keys: ['delivered', 'deferred', 'failed', 'stale'] },
  { name: 'payment_pending_sync', path: '/api/internal/cron/payment-pending-sync', keys: ['queued', 'delivered', 'deferred', 'cancelled', 'manual_review', 'stale'] },
  { name: 'payment_email', path: '/api/internal/cron/payment-email', keys: ['processed', 'accepted', 'delivered', 'failed', 'uncertain', 'cancelled', 'pending'] },
  { name: 'payment_paid_sync', path: '/api/internal/cron/payment-paid-sync', keys: ['queued', 'delivered', 'deferred', 'manual_review', 'stale'] },
  { name: 'square_payment_expiry', path: '/api/internal/cron/square-payment-expiry', keys: ['expiryPending', 'expired', 'deferred', 'manualReview'] },
]);
const ATTENTION_KEYS = new Set(['failed', 'uncertain', 'manual_review', 'manualReview', 'stale']);

async function boundedCounts(response, keys) {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('invalid_response');
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body) throw new Error('invalid_response');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('invalid_response');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || Object.keys(data).length !== keys.length
    || keys.some(key => !Object.hasOwn(data, key) || !Number.isSafeInteger(data[key]) || data[key] < 0 || data[key] > 1000)) {
    throw new Error('invalid_response');
  }
  // Explicit projection: raw responses, unknown fields and strings never enter output.
  return Object.fromEntries(keys.map(key => [key, data[key]]));
}

/** Test transport is injectable; deployed CLI uses fixed HTTPS URLs only. */
export async function runPaymentScheduler(env = process.env, transport = fetch) {
  if (env.FAME_PAYMENT_SCHEDULER_ENABLED !== 'true') {
    return { enabled: false, ok: true, processed: 0, failures: 0, workers: [] };
  }
  const secret = env.CRON_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 4096 || /[\r\n\0]/.test(secret)) {
    return { enabled: true, ok: false, processed: 0, failures: 1, error: 'scheduler_secret_invalid', workers: [] };
  }
  const origin = paymentSchedulerOrigin(env);
  const workers = [];
  // Sequential calls keep shared provider/database load bounded. At 55 seconds
  // each, the complete run is bounded to under six minutes, excluding runner setup.
  for (const worker of WORKERS) {
    let response;
    try {
      response = await transport(origin + worker.path, {
        method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
      });
    } catch {
      workers.push({ worker: worker.name, ok: false, error: 'request_unavailable' });
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      workers.push({ worker: worker.name, ok: false, error: 'http_failure', status: response.status });
      continue;
    }
    try {
      const counts = await boundedCounts(response, worker.keys);
      const needsAttention = Object.entries(counts).some(([key, value]) => ATTENTION_KEYS.has(key) && value > 0);
      workers.push({ worker: worker.name, ok: !needsAttention, ...(needsAttention ? { error: 'worker_needs_attention' } : {}), counts });
    } catch {
      workers.push({ worker: worker.name, ok: false, error: 'invalid_worker_response' });
    }
  }
  const failures = workers.filter(worker => !worker.ok).length;
  return { enabled: true, ok: failures === 0, processed: workers.length, failures, workers };
}

export async function main(env = process.env, transport = fetch, write = value => process.stdout.write(value + '\n')) {
  const result = await runPaymentScheduler(env, transport);
  write(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    process.stderr.write('{"ok":false,"error":"scheduler_unavailable"}\n');
    process.exitCode = 1;
  });
}
