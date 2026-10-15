const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../.test-build/payment-reminder-template.js');
const templates = require('../.test-build/email-templates.js');

const values = { name: 'Devin Luna', business: 'Heritage Bloom Farms', total: '$175.00', dates: 'Saturday, October 3, 2026', link: 'https://freshairmarketsandevents.com/vendor/payment#token=abc' };

test('placeholders fill per vendor and paragraphs split on blank lines', () => {
  const out = t.renderPaymentReminder({ subject: 'Hi {business} ({total})', message: 'Hi {name},\n\nYou owe {total} for {dates}.\nThanks!\n\nPay: {link}' }, values);
  assert.equal(out.subject, 'Hi Heritage Bloom Farms ($175.00)');
  assert.deepEqual(out.paragraphs, ['Hi Devin Luna,', 'You owe $175.00 for Saturday, October 3, 2026.\nThanks!', `Pay: ${values.link}`]);
});

test('the payment link is always included even if staff delete {link}', () => {
  const out = t.renderPaymentReminder({ subject: 's', message: 'Please pay soon.' }, values);
  assert.match(out.paragraphs.at(-1), /abc$/);
});

test('the standard wording renders the same facts as before', () => {
  const out = t.renderPaymentReminder({ subject: t.DEFAULT_REMINDER_SUBJECT, message: t.DEFAULT_REMINDER_MESSAGE }, values);
  assert.match(out.subject, /\$175\.00/);
  assert.equal(out.paragraphs.length, 4);
  assert.match(out.paragraphs[1], /Saturday, October 3, 2026/);
  assert.equal(t.reminderDates(['2026-10-03', '2026-10-10']), 'Saturday, October 3, 2026, Saturday, October 10, 2026');
});

test('staff input is cleaned and limited', () => {
  assert.deepEqual(t.cleanReminderTemplate(' A\nB ', ' x\r\n\r\ny '), { subject: 'A B', message: 'x\n\ny' });
  for (const [s, m] of [['', 'x'], ['x', ''], [1, 'x'], ['x'.repeat(201), 'x'], ['x', 'y'.repeat(5001)]]) assert.ok('error' in t.cleanReminderTemplate(s, m));
});

test('the sent email escapes staff text and links the payment link', () => {
  const email = templates.customPaymentReminderEmail({ subject: 's', message: 'Hi <b>{name}</b>\nline two\n\n{link}' }, values);
  assert.match(email.html, /Hi &lt;b&gt;Devin Luna&lt;\/b&gt;<br>line two/);
  assert.match(email.html, /<a href="https:\/\/freshairmarketsandevents\.com\/vendor\/payment#token=abc">/);
  assert.match(email.text, /— Fresh Air Markets & Events/);
});

test('the dates-changed email lists old and new dates, total and the link once', () => {
  const email = templates.bookingDatesChangedEmail({ name: 'Cristy', oldDates: ['2026-11-07'], newDates: ['2026-10-24', '2026-10-31'], booths: 1, totalCents: 8000, link: 'https://freshairmarketsandevents.com/vendor/payment#token=abc', note: 'As we discussed.' });
  assert.match(email.subject, /dates have changed.*\$80\.00/);
  assert.match(email.text, /new dates are Saturday, October 24, 2026, Saturday, October 31, 2026 \(1 booth\)\. Total due: \$80\.00/);
  assert.match(email.text, /previous dates \(Saturday, November 7, 2026\) are released/);
  assert.match(email.text, /As we discussed\./);
  assert.equal(email.text.split('token=abc').length, 2);
});
