const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'unit-test-secret-that-is-long-enough-1234567890';
const { makeSessionToken, makeStaffSessionToken, verifySessionIdentity, verifySessionToken } = require('../.test-build/auth.js');

test('legacy market sessions and staff sessions both verify, and tampering or bad ids are rejected', () => {
  const legacy = makeSessionToken('fame-market');
  assert.deepEqual(verifySessionIdentity(legacy), { marketId: 'fame-market', userId: null });
  assert.equal(verifySessionToken(legacy), 'fame-market');
  const staff = makeStaffSessionToken('fame-market', 'staff-1');
  assert.deepEqual(verifySessionIdentity(staff), { marketId: 'fame-market', userId: 'staff-1' });
  assert.equal(verifySessionToken(staff), 'fame-market');
  const [market, user, expires, sig] = staff.split('.');
  assert.equal(verifySessionIdentity(`${market}.other.${expires}.${sig}`), null);
  assert.equal(verifySessionIdentity(`${market}.${user}.${Number(expires) + 1}.${sig}`), null);
  assert.equal(verifySessionIdentity(`${market}.${user}.${expires}.${'0'.repeat(64)}`), null);
  assert.equal(verifySessionIdentity(`${market}.${expires}.${sig}`), null);
  assert.equal(verifySessionIdentity(undefined), null);
  assert.equal(verifySessionIdentity('a.b'), null);
  assert.throws(() => makeStaffSessionToken('fame.market', 'staff-1'));
  assert.throws(() => makeStaffSessionToken('fame-market', ''));
});
