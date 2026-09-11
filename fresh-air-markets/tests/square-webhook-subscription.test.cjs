const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSquareWebhookSubscriptions, selectPortalSubscription, syncSquareWebhookSubscription } = require('../.test-build/square-webhook-subscription.js');

const OLD = 'https://farmers-market-wine.vercel.app/api/payments/square/webhook';
const NEW = 'https://freshairmarketsandevents.com/api/payments/square/webhook';
const config = { environment: 'production', accessToken: 'unit-token' };
const sub = (patch = {}) => ({ id: 'wbs_1', name: 'Fresh Air portal', enabled: true, notification_url: OLD, event_types: ['payment.created', 'payment.updated'], ...patch });

function transportWith(subscriptions, onPut) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    if (init.method === 'GET') return new Response(JSON.stringify({ subscriptions }), { status: 200 });
    if (init.method === 'PUT') return onPut ? onPut(url, init) : new Response(JSON.stringify({ subscription: { ...subscriptions[0], notification_url: JSON.parse(init.body).subscription.notification_url } }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  return { transport, calls };
}

test('parsing tolerates unexpected shapes and selection ignores other apps, disabled rows and non-payment subscriptions', () => {
  assert.deepEqual(parseSquareWebhookSubscriptions(null), []);
  assert.deepEqual(parseSquareWebhookSubscriptions({ subscriptions: [{ id: 'x' }, 'junk', { id: '', notification_url: OLD }] }), []);
  const parsed = parseSquareWebhookSubscriptions({ subscriptions: [
    sub(), sub({ id: 'other', notification_url: 'https://other.example/hooks' }), sub({ id: 'off', enabled: false }),
    sub({ id: 'orders', event_types: ['order.updated'] }), sub({ id: 'exact', notification_url: NEW }),
  ] });
  assert.equal(parsed.length, 5);
  assert.equal(selectPortalSubscription(parsed, NEW).id, 'exact');
  assert.equal(selectPortalSubscription(parsed.filter(s => s.id !== 'exact'), NEW).id, 'wbs_1');
  assert.equal(selectPortalSubscription(parsed.filter(s => ['other', 'off', 'orders'].includes(s.id)), NEW), null);
});

test('a dry run reports the mismatch without writing; apply rewrites only the notification URL of the matched subscription', async () => {
  const dry = transportWith([sub(), sub({ id: 'other', notification_url: 'https://other.example/hooks' })]);
  const report = await syncSquareWebhookSubscription(config, NEW, { apply: false, transport: dry.transport });
  assert.deepEqual(report, { expectedUrl: NEW, subscription: { id: 'wbs_1', name: 'Fresh Air portal', notificationUrl: OLD, eventTypes: ['payment.created', 'payment.updated'] }, inSync: false, updated: false, candidates: 1 });
  assert.deepEqual(dry.calls.map(c => c.method), ['GET']);
  assert.equal(dry.calls[0].auth, 'Bearer unit-token');
  assert.match(dry.calls[0].url, /^https:\/\/connect\.squareup\.com\/v2\/webhooks\/subscriptions/);

  const live = transportWith([sub()]);
  const applied = await syncSquareWebhookSubscription(config, NEW, { apply: true, transport: live.transport });
  assert.equal(applied.inSync, true);
  assert.equal(applied.updated, true);
  assert.equal(applied.subscription.notificationUrl, NEW);
  assert.deepEqual(live.calls.map(c => c.method), ['GET', 'PUT']);
  assert.equal(live.calls[1].url, 'https://connect.squareup.com/v2/webhooks/subscriptions/wbs_1');
  assert.deepEqual(live.calls[1].body, { subscription: { notification_url: NEW } });
});

test('already-synced, missing and failing subscriptions never trigger a write, and the expected URL must be the portal path over HTTPS', async () => {
  const synced = transportWith([sub({ notification_url: NEW })]);
  const report = await syncSquareWebhookSubscription(config, NEW, { apply: true, transport: synced.transport });
  assert.equal(report.inSync, true);
  assert.equal(report.updated, false);
  assert.deepEqual(synced.calls.map(c => c.method), ['GET']);

  const none = transportWith([sub({ id: 'other', notification_url: 'https://other.example/hooks' })]);
  const missing = await syncSquareWebhookSubscription(config, NEW, { apply: true, transport: none.transport });
  assert.deepEqual(missing, { expectedUrl: NEW, subscription: null, inSync: false, updated: false, candidates: 0 });
  assert.deepEqual(none.calls.map(c => c.method), ['GET']);

  const failing = { transport: async () => new Response('{"errors":[{"detail":"secret"}]}', { status: 401 }) };
  await assert.rejects(() => syncSquareWebhookSubscription(config, NEW, { apply: true, transport: failing.transport }), /failed \(401\)/);
  await assert.rejects(() => syncSquareWebhookSubscription(config, 'http://freshairmarketsandevents.com/api/payments/square/webhook', { apply: false, transport: synced.transport }), /HTTPS/);
  await assert.rejects(() => syncSquareWebhookSubscription(config, 'https://freshairmarketsandevents.com/other', { apply: false, transport: synced.transport }), /portal webhook path/);
});
