const { test } = require('node:test');
const assert = require('node:assert/strict');
const { newPasswordResetToken, passwordResetTokenHash, validPasswordResetToken, passwordProblem, MIN_PASSWORD_LENGTH } = require('../.test-build/password-reset.js');
const { passwordResetEmail } = require('../.test-build/email-templates.js');

test('reset tokens are 32 random bytes, only their hash is comparable, and malformed tokens are rejected', () => {
  const a = newPasswordResetToken();
  const b = newPasswordResetToken();
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.token, b.token);
  assert.equal(a.tokenHash, passwordResetTokenHash(a.token));
  assert.match(a.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(validPasswordResetToken(a.token), true);
  for (const bad of [undefined, null, 42, '', 'short', a.token + 'x', a.token.slice(1) + '/', `${a.token}.`]) assert.equal(validPasswordResetToken(bad), false, String(bad));
});

test('password policy requires a real password of at least the minimum length', () => {
  assert.equal(passwordProblem('x'.repeat(MIN_PASSWORD_LENGTH)), null);
  assert.match(passwordProblem('x'.repeat(MIN_PASSWORD_LENGTH - 1)), /at least/);
  assert.match(passwordProblem(' '.repeat(MIN_PASSWORD_LENGTH)), /Enter a new password/);
  assert.match(passwordProblem('x'.repeat(201)), /at most/);
  assert.match(passwordProblem(undefined), /Enter a new password/);
  assert.match(passwordProblem(123456789012), /Enter a new password/);
});

test('the reset email carries the link, the time limit and the single-use warning', () => {
  const email = passwordResetEmail({ name: 'Thomas', link: 'https://freshairmarketsandevents.com/reset-password#token=abc_DEF-123', minutes: 30 });
  assert.match(email.subject, /Reset your .* password/);
  assert.match(email.text, /within 30 minutes: https:\/\/freshairmarketsandevents\.com\/reset-password#token=abc_DEF-123/);
  assert.match(email.html, /<a href="https:\/\/freshairmarketsandevents\.com\/reset-password#token=abc_DEF-123">/);
  assert.match(email.text, /works once/);
});
