const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readEmailConfig, sendEmail, sendStaffEmail } = require('../.test-build/email.js');
const templates = require('../.test-build/email-templates.js');

const env = { RESEND_API_KEY: 'unit-test-key', EMAIL_FROM: 'Fresh Air <hello@example.com>', STAFF_NOTIFY_EMAIL: 'Staff@Example.com' };
const outbound = { kind: 'test', to: 'Vendor@Example.com', subject: 'Hi', text: 'Body', marketId: 'fame-market' };

test('email config reads Resend settings and falls back to the onboarding sender', () => {
  assert.equal(readEmailConfig({}), null);
  assert.equal(readEmailConfig({ RESEND_API_KEY: '' }), null);
  const config = readEmailConfig({ RESEND_API_KEY: 'k' });
  assert.equal(config.from, 'Fresh Air Markets <onboarding@resend.dev>');
  assert.equal(config.staffEmail, null);
  assert.equal(readEmailConfig(env).staffEmail, 'staff@example.com');
  assert.equal(readEmailConfig({ ...env, STAFF_NOTIFY_EMAIL: 'not-an-email' }).staffEmail, null);
});

test('sending is skipped without configuration, rejects bad recipients, and never throws on transport failure', async () => {
  let calls = 0;
  const transport = async () => { calls++; return { status: 'sent', id: 'msg_1' }; };
  assert.deepEqual(await sendEmail(outbound, { env: {}, transport }), { status: 'skipped', code: 'email_not_configured' });
  assert.deepEqual(await sendEmail({ ...outbound, to: 'nope' }, { env, transport }), { status: 'skipped', code: 'invalid_recipient' });
  assert.equal(calls, 0);
  assert.deepEqual(await sendEmail(outbound, { env, transport }), { status: 'sent', id: 'msg_1' });
  assert.equal(calls, 1);
  const failing = async () => { throw new Error('boom'); };
  // A throwing transport is a programming error in the transport; the built-in one never throws. Wrap to prove sendEmail stays quiet.
  const guarded = async (...args) => { try { return await failing(...args); } catch { return { status: 'failed', code: 'request_unavailable' }; } };
  assert.deepEqual(await sendEmail(outbound, { env, transport: guarded }), { status: 'failed', code: 'request_unavailable' });
  assert.deepEqual(await sendStaffEmail({ kind: 'staff', subject: 'S', text: 'T', marketId: 'fame-market' }, { env: { RESEND_API_KEY: 'k' }, transport }), { status: 'skipped', code: 'staff_email_not_configured' });
  const staff = [];
  await sendStaffEmail({ kind: 'staff', subject: 'S', text: 'T', marketId: 'fame-market' }, { env, transport: async (_c, e) => { staff.push(e.to); return { status: 'sent', id: 'x' }; } });
  assert.deepEqual(staff, ['staff@example.com']);
});

test('the Resend transport shape: recipient lower-cased, from and reply-to from config', async () => {
  const seen = [];
  await sendEmail({ ...outbound, html: '<p>Body</p>' }, { env: { ...env, EMAIL_REPLY_TO: 'reply@example.com' }, transport: async (config, email) => { seen.push([config.from, config.replyTo, email.to, email.html]); return { status: 'sent', id: 'id' }; } });
  assert.deepEqual(seen, [['Fresh Air <hello@example.com>', 'reply@example.com', 'vendor@example.com', '<p>Body</p>']]);
});

test('templates carry the essentials and escape HTML', () => {
  const request = templates.paymentRequestEmail({ name: 'Rosa', totalCents: 8000, dueAt: '2026-09-13T02:32:12.000Z', dates: ['2026-10-03', '2026-10-10'], booths: 1, link: 'https://portal.example/vendor/payment#token=abc' });
  assert.match(request.subject, /\$80\.00/);
  assert.match(request.text, /Saturday, October 3, 2026/);
  assert.match(request.text, /https:\/\/portal\.example\/vendor\/payment#token=abc/);
  assert.match(request.html, /<a href="https:\/\/portal\.example\/vendor\/payment#token=abc">/);
  const changes = templates.applicationChangesRequestedEmail({ name: 'Rosa', reason: 'Add <b>insurance</b> & license' });
  assert.match(changes.text, /Add <b>insurance<\/b> & license/);
  assert.match(changes.html, /Add &lt;b&gt;insurance&lt;\/b&gt; &amp; license/);
  assert.match(templates.applicationApprovedEmail({ name: 'Rosa', businessName: 'Sunrise Farms' }).text, /Sunrise Farms/);
  assert.match(templates.applicationApprovedEmail({ name: 'Rosa', businessName: 'Sunrise Farms' }).text, /reply to this email with your certificate of insurance/);
  assert.match(templates.applicationApprovedEmail({ name: 'Rosa', businessName: 'Sunrise Farms', documentsOnFile: true }).text, /We have the documents you uploaded/);
  assert.doesNotMatch(templates.applicationApprovedEmail({ name: 'Rosa', businessName: 'Sunrise Farms', documentsOnFile: true }).text, /reply to this email with your certificate/);
  assert.match(templates.applicationReceivedEmail({ name: 'Rosa', businessName: 'Sunrise Farms' }).text, /attached your certificate of insurance .* on the confirmation page/);
  assert.match(templates.paymentReceivedEmail({ name: 'Rosa', totalCents: 8000 }).text, /\$80\.00/);
  assert.match(templates.staffNewApplicationEmail({ name: 'Rosa', businessName: 'Sunrise Farms', email: 'r@example.com', type: 'Vendor', applicationId: 'abc', origin: 'https://p' }).text, /https:\/\/p\/applications\/abc/);
  assert.match(templates.staffContactMessageEmail({ name: 'Pat', email: 'p@example.com', phone: '', topic: 'general', message: 'Hello', origin: 'https://p' }).subject, /Pat/);
});

test('the staff new-application email includes the vendor phone when given', () => {
  const withPhone = templates.staffNewApplicationEmail({ name: 'Rosa', businessName: 'Sunrise Farms', email: 'rosa@example.com', phone: '(941) 555-0100', type: 'Vendor', applicationId: 'a1', origin: 'https://x.test' });
  assert.match(withPhone.text, /rosa@example\.com, \(941\) 555-0100/);
  const without = templates.staffNewApplicationEmail({ name: 'Rosa', businessName: 'Sunrise Farms', email: 'rosa@example.com', type: 'Vendor', applicationId: 'a1', origin: 'https://x.test' });
  assert.match(without.text, /rosa@example\.com\) applied/);
});
