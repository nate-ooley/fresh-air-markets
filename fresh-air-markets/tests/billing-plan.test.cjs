const { test } = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../.test-build/billing-plan.js');

const base = { quotedCents: 105000, today: '2026-10-15', firstDueOn: '2026-11-01', totalCents: 105000, plan: 'full' };

test('monthly payments split to the cent, last one absorbs rounding, dates step a month and clamp to month end', () => {
  const schedule = plan.monthlySchedule(100000, 3, '2027-01-31');
  assert.deepEqual(schedule.map(item => item.amountCents), [33333, 33333, 33334]);
  assert.equal(schedule.reduce((sum, item) => sum + item.amountCents, 0), 100000);
  assert.deepEqual(schedule.map(item => item.dueOn), ['2027-01-31', '2027-02-28', '2027-03-31']);
  assert.equal(plan.addMonths('2026-12-15', 1), '2027-01-15');
});

test('pay in full is one payment of the booking price', () => {
  const full = plan.planBilling(base);
  assert.deepEqual(full, { plan: 'full', totalCents: 105000, reason: '', installments: [{ seq: 1, dueOn: '2026-11-01', amountCents: 105000 }] });
});

test('a monthly plan needs 2 to 12 payments of at least $1', () => {
  const monthly = plan.planBilling({ ...base, plan: 'monthly', installments: 6 });
  assert.equal(monthly.installments.length, 6);
  assert.equal(monthly.installments[5].dueOn, '2027-04-01');
  for (const installments of [1, 13, 2.5, '6', undefined]) assert.ok('error' in plan.planBilling({ ...base, plan: 'monthly', installments }), String(installments));
  assert.ok('error' in plan.planBilling({ ...base, plan: 'monthly', installments: 12, totalCents: 1100, quotedCents: 1100 }));
});

test('a different amount needs a reason; silly amounts, past or invalid dates and unknown plans are refused', () => {
  assert.ok('error' in plan.planBilling({ ...base, totalCents: 90000 }));
  assert.equal(plan.planBilling({ ...base, totalCents: 90000, reason: '  10% off,  agreed  ' }).reason, '10% off, agreed');
  for (const patch of [{ totalCents: 99 }, { totalCents: 105000 * 10 + 1, reason: 'x' }, { totalCents: 1.5 }, { firstDueOn: '2026-10-14' }, { firstDueOn: '2026-02-30' }, { firstDueOn: 'soon' }, { plan: 'weekly' }, { totalCents: 90000, reason: 'x'.repeat(301) }]) {
    assert.ok('error' in plan.planBilling({ ...base, ...patch }), JSON.stringify(patch));
  }
});
