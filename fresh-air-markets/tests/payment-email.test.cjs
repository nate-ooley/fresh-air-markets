const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { encryptPaymentEmailInvitation, decryptPaymentEmailInvitation, validatePaymentEmailSecret } = require('../.test-build/payment-email.js');
const secret = randomBytes(32).toString('base64url');
const context = { id: 'qa-notification', marketId: 'qa-market', reservationId: 'qa-reservation', revision: 1, recipientEmail: 'lnooley@gmail.com' };
const invitation = 'https://qa-market.vercel.app/vendor/payment#token=' + randomBytes(32).toString('base64url');

test('payment email encryption roundtrips without persisting plaintext token or URL', () => {
  const envelope = encryptPaymentEmailInvitation(invitation, secret, context);
  assert.equal(decryptPaymentEmailInvitation(envelope, secret, context), invitation);
  assert.equal(envelope.includes(invitation), false);
  assert.equal(envelope.includes(invitation.split('#token=')[1]), false);
});
test('payment email fresh encryption uses different nonce and authenticated ciphertext', () => {
  const envelopes = new Set(Array.from({ length: 100 }, () => encryptPaymentEmailInvitation(invitation, secret, context)));
  assert.equal(envelopes.size, 100);
  for (const envelope of envelopes) assert.equal(decryptPaymentEmailInvitation(envelope, secret, context), invitation);
});
test('payment email AAD binds notification, market, reservation, revision and recipient', () => {
  const envelope = encryptPaymentEmailInvitation(invitation, secret, context);
  for (const key of Object.keys(context)) {
    assert.throws(() => decryptPaymentEmailInvitation(envelope, secret, { ...context, [key]: key === 'revision' ? 2 : 'different' }));
  }
});
test('payment email rejects altered ciphertext, wrong key and malformed envelopes', () => {
  const envelope = encryptPaymentEmailInvitation(invitation, secret, context);
  assert.throws(() => decryptPaymentEmailInvitation(envelope, randomBytes(32).toString('base64url'), context));
  const pieces = envelope.split('.');
  pieces[3] = (pieces[3][0] === 'A' ? 'B' : 'A') + pieces[3].slice(1);
  for (const invalid of [pieces.join('.'), 'v2.a.b.c', '', envelope + '.extra', 'v1.ab.cd.ef']) {
    assert.throws(() => decryptPaymentEmailInvitation(invalid, secret, context));
  }
});
test('payment email refuses demo, short, repetitive and placeholder authentication secrets', () => {
  for (const invalid of ['', 'demo-secret-change-me', 'short', 'a'.repeat(64), 'QA-only replace-me connection secret 0123456789']) {
    assert.throws(() => validatePaymentEmailSecret(invalid));
  }
  assert.doesNotThrow(() => validatePaymentEmailSecret(secret));
});
