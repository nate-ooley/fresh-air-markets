const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const scriptUrl = pathToFileURL(path.resolve(__dirname, '../scripts/generate-square-qa-webhook-fixture.mjs')).href;

async function fixtureScript() {
  return import(scriptUrl);
}

const mapping = [
  '--merchant-id', 'qa-merchant-1',
  '--location-id', 'qa-location-1',
  '--order-id', 'qa-order-1',
  '--payment-id', 'qa-payment-1',
  '--amount-cents', '28000',
  '--payment-created-at', '2026-09-07T12:00:00.000Z',
  '--payment-updated-at', '2026-09-07T12:01:00.000Z',
];

function input(fixtureCase, extra = []) {
  const overrideFlags = new Set(extra.filter((_value, index) => index % 2 === 0));
  const base = [];
  for (let index = 0; index < mapping.length; index += 2) {
    if (!overrideFlags.has(mapping[index])) base.push(mapping[index], mapping[index + 1]);
  }
  return ['--case', fixtureCase, '--out', '/private/tmp/unused.json', ...base, ...extra];
}

test('the local fixture helper creates each route-relevant event shape without environment or network access', async () => {
  const { buildFixture, parseArguments } = await fixtureScript();
  const valid = buildFixture(parseArguments(input('valid')));
  assert.equal(valid.type, 'payment.updated');
  assert.equal(valid.data.type, 'payment');
  assert.equal(valid.data.object.payment.status, 'COMPLETED');

  const malformed = buildFixture(parseArguments(['--case', 'malformed', '--out', '/private/tmp/unused.json', '--event-id', 'qa-malformed-1']));
  assert.equal(malformed.data.type, 'refund');

  const wrongMerchant = buildFixture(parseArguments(input('wrong-identity', ['--mismatch', 'merchant'])));
  assert.notEqual(wrongMerchant.merchant_id, 'qa-merchant-1');
  const wrongMoney = buildFixture(parseArguments(input('wrong-identity', ['--mismatch', 'amount'])));
  assert.equal(wrongMoney.data.object.payment.order_id, 'qa-order-1');
  assert.equal(wrongMoney.data.object.payment.amount_money.amount, 28001);

  const late = buildFixture(parseArguments(input('late', [
    '--due-at', '2026-09-07T12:00:00.000Z', '--payment-updated-at', '2026-09-07T12:00:00.001Z',
  ])));
  assert.equal(late.data.object.payment.status, 'COMPLETED');

  const failed = buildFixture(parseArguments(input('failed')));
  assert.equal(failed.data.object.payment.status, 'FAILED');

  const older = buildFixture(parseArguments(input('out-of-order', ['--after-at', '2026-09-07T12:02:00.000Z'])));
  assert.equal(older.data.object.payment.status, 'FAILED');
});

test('the local fixture helper rejects cases that cannot prove their intended time or mapping condition', async () => {
  const { buildFixture, parseArguments } = await fixtureScript();
  assert.throws(() => buildFixture(parseArguments(['--case', 'valid', '--out', '/private/tmp/unused.json'])));
  assert.throws(() => buildFixture(parseArguments(input('late', [
    '--due-at', '2026-09-07T12:01:00.000Z', '--payment-updated-at', '2026-09-07T12:01:00.000Z',
  ]))));
  assert.throws(() => buildFixture(parseArguments(input('out-of-order', [
    '--after-at', '2026-09-07T12:01:00.000Z', '--payment-updated-at', '2026-09-07T12:02:00.000Z',
  ]))));
  assert.throws(() => parseArguments(['--case', 'unknown', '--out', '/private/tmp/unused.json']));
});

test('the local fixture helper writes one private local file and never overwrites a saved replay artifact', async () => {
  const { main } = await fixtureScript();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fame-square-fixture-'));
  const output = path.join(directory, 'event.json');
  try {
    const args = ['--case', 'valid', '--out', output, ...mapping];
    const written = await main(args, fs.promises.writeFile, () => {});
    assert.equal(written.data.object.payment.order_id, 'qa-order-1');
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).event_id.startsWith('qa-sq-valid-'), true);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    await assert.rejects(main(args, fs.promises.writeFile, () => {}));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
