const { test } = require('node:test');
const assert = require('node:assert/strict');
const { uploadPlan, uploadFailureMessage, MAX_UPLOAD_BYTES } = require('../.test-build/upload-prepare.js');

test('small images and PDFs are sent as-is; big or HEIC photos are shrunk; big PDFs are refused with a readable reason', () => {
  assert.deepEqual(uploadPlan({ type: 'image/jpeg', name: 'coi.jpg', size: 900_000 }), { action: 'send' });
  assert.deepEqual(uploadPlan({ type: 'image/jpeg', name: 'IMG_1234.JPG', size: 6_800_000 }), { action: 'shrink' });
  assert.deepEqual(uploadPlan({ type: 'image/heic', name: 'IMG_1234.HEIC', size: 1_200_000 }), { action: 'shrink' });
  assert.deepEqual(uploadPlan({ type: '', name: 'IMG_1234.heic', size: 1_200_000 }), { action: 'shrink' });
  assert.deepEqual(uploadPlan({ type: 'application/pdf', name: 'coi.pdf', size: 3_000_000 }), { action: 'send' });
  const big = uploadPlan({ type: 'application/pdf', name: 'coi.pdf', size: MAX_UPLOAD_BYTES + 1 });
  assert.equal(big.action, 'reject');
  assert.match(big.reason, /larger than 4 MB/);
});

test('gateway refusals become plain messages instead of raw error text', () => {
  assert.match(uploadFailureMessage(413, undefined), /too large to send/);
  assert.match(uploadFailureMessage(502, undefined), /didn't respond/);
  assert.equal(uploadFailureMessage(400, 'Only PDF, PNG and JPEG files are accepted.'), 'Only PDF, PNG and JPEG files are accepted.');
  assert.equal(uploadFailureMessage(400, undefined), 'The file was not accepted.');
});
