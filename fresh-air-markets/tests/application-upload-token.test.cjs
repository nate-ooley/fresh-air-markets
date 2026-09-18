const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApplicationUploadToken, verifyApplicationUploadToken } = require('../.test-build/application-upload-token.js');

const env = { NODE_ENV: 'production', AUTH_SECRET: 'unit-test-only-signing-secret-at-least-32-chars' };
const applicationId = '11111111-1111-4111-8111-111111111111';

test('upload tokens are scoped to one application and market, signed, and expire', () => {
  const now = 1_800_000_000_000;
  const token = createApplicationUploadToken(applicationId, 'fame-market', env, now);
  assert.deepEqual(verifyApplicationUploadToken(token, env, now + 60_000), { applicationId, marketId: 'fame-market' });
  assert.equal(verifyApplicationUploadToken(token, env, now + 3 * 60 * 60 * 1000), null);
  assert.equal(verifyApplicationUploadToken(token, { ...env, AUTH_SECRET: 'a-different-secret-that-is-also-32-chars-long' }, now), null);
  assert.equal(verifyApplicationUploadToken(token.slice(0, -2) + 'xx', env, now), null);
  assert.equal(verifyApplicationUploadToken(token.replace(/^[^.]+/, Buffer.from(JSON.stringify(['not-a-uuid', 'fame-market', now + 1000])).toString('base64url')), env, now), null);
  for (const bad of [undefined, '', 'a.b', 'x'.repeat(600), 42]) assert.equal(verifyApplicationUploadToken(bad, env, now), null);
  assert.equal(verifyApplicationUploadToken(token, { NODE_ENV: 'production' }, now), null);
});

test('emailed upload links can carry a longer life than the post-submit token', () => {
  const { createApplicationUploadToken, verifyApplicationUploadToken, EMAILED_UPLOAD_TTL_MS } = require('../.test-build/application-upload-token.js');
  const env = { AUTH_SECRET: 'unit-test-secret-that-is-long-enough-1234567890' };
  const now = Date.parse('2026-09-17T12:00:00Z');
  const short = createApplicationUploadToken('22222222-2222-4222-8222-222222222222', 'fame-market', env, now);
  const long = createApplicationUploadToken('22222222-2222-4222-8222-222222222222', 'fame-market', env, now, EMAILED_UPLOAD_TTL_MS);
  assert.equal(verifyApplicationUploadToken(short, env, now + 3 * 60 * 60 * 1000), null);
  assert.deepEqual(verifyApplicationUploadToken(long, env, now + 13 * 24 * 60 * 60 * 1000), { applicationId: '22222222-2222-4222-8222-222222222222', marketId: 'fame-market' });
  assert.equal(verifyApplicationUploadToken(long, env, now + 15 * 24 * 60 * 60 * 1000), null);
});
