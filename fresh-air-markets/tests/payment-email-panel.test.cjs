const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Real component handlers run against isolated hook/network boundaries. This
// verifies UI behavior; it does not substitute for rendered browser/inbox QA.
function panelHarness() {
  const hooks = [];
  let index = 0, effects = [], props = { reservationId: 'reservation-1' }, tree;
  const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const slot = index++;
      if (!hooks[slot]) hooks[slot] = { state: typeof initial === 'function' ? initial() : initial };
      return [hooks[slot].state, value => { hooks[slot].state = typeof value === 'function' ? value(hooks[slot].state) : value; }];
    },
    useRef(initial) { const slot = index++; if (!hooks[slot]) hooks[slot] = { ref: { current: initial } }; return hooks[slot].ref; },
    useCallback(callback, deps) {
      const slot = index++;
      if (!hooks[slot] || !equalDeps(hooks[slot].deps, deps)) hooks[slot] = { callback, deps };
      return hooks[slot].callback;
    },
    useEffect(effect, deps) {
      const slot = index++;
      if (!hooks[slot] || !equalDeps(hooks[slot].deps, deps)) {
        const previousCleanup = hooks[slot]?.cleanup;
        hooks[slot] = { deps };
        effects.push(() => { previousCleanup?.(); hooks[slot].cleanup = effect(); });
      }
    },
  };
  const filename = path.resolve(__dirname, '../src/components/PaymentEmailPanel.tsx');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = module.paths;
  mod.require = id => id === 'react' ? react : require(id);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, filename);
  const component = mod.exports.default;
  function render(nextProps) { if (nextProps) props = nextProps; index = 0; tree = component(props); return tree; }
  function all(node, predicate) {
    if (!node || typeof node !== 'object') return [];
    return [...(predicate(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => all(child, predicate))];
  }
  function text(node) {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (!node || typeof node !== 'object') return '';
    return [node.props?.children].flat(Infinity).map(text).join(' ');
  }
  render();
  return { render,
    flushEffects() { const current = effects; effects = []; current.forEach(effect => effect()); },
    button(label) { return all(tree, node => node.type === 'button' && text(node) === label)[0]; },
    checkbox() { return all(tree, node => node.type === 'input' && node.props.type === 'checkbox')[0]; },
    alerts() { return all(tree, node => node.props?.role === 'alert').map(text); },
    text() { return text(tree); }, dispose() { hooks.forEach(hook => hook?.cleanup?.()); },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const record = (status, canRetryPreflight = false) => ({ notification: { id: 'notification-1', status, canRetryPreflight } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }
async function boundary(run) {
  const previousFetch = global.fetch, calls = [];
  let responder = () => { throw new Error('Unexpected fetch'); }, panel;
  global.fetch = async (url, options) => { const call = { url, options }; calls.push(call); return responder(call); };
  try {
    panel = panelHarness();
    await run({ panel, calls, respond: fn => { responder = fn; },
      async mount() { panel.flushEffects(); await flush(); panel.render(); },
      async click(label) { assert.ok(panel.button(label), label); panel.button(label).props.onClick(); await flush(); panel.render(); },
      confirm() { assert.ok(panel.checkbox()); panel.checkbox().props.onChange({ target: { checked: true } }); panel.render(); },
    });
  } finally { panel?.dispose(); global.fetch = previousFetch; }
}

test('mount and rerender only read status; there is no automatic payment email', async () => boundary(async ({ panel, calls, respond, mount }) => {
  respond(() => json({ notification: null })); assert.equal(calls.length, 0);
  await mount(); panel.render(); panel.flushEffects(); await flush();
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/admin/reservations/reservation-1/payment-email');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.body, undefined); assert.equal(panel.checkbox().props.checked, false);
  assert.equal(panel.button('Send payment email').props.disabled, true);
  assert.match(panel.text(), /replaces earlier links and sessions/);
}));

test('send requires explicit confirmation and sends no browser-selected recipient or payment fields', async () => boundary(async ({ panel, calls, respond, mount, click, confirm }) => {
  respond(call => json(call.options.method === 'GET' ? { notification: null } : record('pending')));
  await mount(); await click('Send payment email'); assert.equal(calls.length, 1);
  confirm(); assert.equal(panel.button('Send payment email').props.disabled, false);
  await click('Send payment email');
  assert.equal(calls.length, 2); assert.equal(calls[1].options.method, 'POST'); assert.equal(calls[1].options.body, '{}');
  assert.deepEqual(calls[1].options.headers, { 'Content-Type': 'application/json' });
  assert.equal(panel.button('Send payment email'), undefined); assert.equal(panel.checkbox(), undefined);
  assert.match(panel.text(), /Queued for delivery/); assert.doesNotMatch(panel.text(), /reports that the email was delivered/);
}));

test('rapid repeated clicks submit one POST and block simultaneous refresh during submission', async () => boundary(async ({ panel, calls, respond, mount, confirm }) => {
  const pending = deferred(); respond(call => call.options.method === 'POST' ? pending.promise : json({ notification: null }));
  await mount(); confirm();
  const send = panel.button('Send payment email').props.onClick, refresh = panel.button('Refresh delivery status').props.onClick;
  send(); send(); send(); refresh(); refresh();
  assert.equal(calls.length, 2); assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  panel.render(); assert.equal(panel.button('Submitting…').props.disabled, true);
  assert.equal(panel.button('Refresh delivery status').props.disabled, true);
  pending.resolve(json(record('accepted'))); await flush(); panel.render();
  assert.match(panel.text(), /HighLevel accepted the email/); assert.match(panel.text(), /Inbox delivery has not yet been confirmed/);
}));

test('accepted and provider-delivered states are distinct; deliberate refresh only issues GET', async () => boundary(async ({ panel, calls, respond, mount, click }) => {
  respond(() => json(record(calls.length === 1 ? 'accepted' : 'delivered'))); await mount();
  assert.match(panel.text(), /Inbox delivery has not yet been confirmed/); assert.doesNotMatch(panel.text(), /reports that the email was delivered/);
  await click('Refresh delivery status'); assert.match(panel.text(), /HighLevel reports that the email was delivered/);
  assert.equal(panel.button('Send payment email'), undefined); assert.equal(calls.length, 2);
  assert.equal(calls.every(call => call.options.method === 'GET'), true);
}));

test('uncertain submission stays held for review across refresh and never offers a resend', async () => boundary(async ({ panel, calls, respond, mount, click, confirm }) => {
  respond(() => json(calls.length === 1 ? { notification: null } : record('uncertain')));
  await mount(); confirm(); await click('Send payment email');
  assert.match(panel.text(), /send result is uncertain/); assert.equal(panel.button('Send payment email'), undefined);
  assert.equal(panel.checkbox(), undefined); panel.render(); panel.flushEffects(); await flush();
  await click('Refresh delivery status'); await click('Refresh delivery status');
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(panel.button('Send payment email'), undefined); assert.match(panel.text(), /not automatically sent again/);
}));

test('existing statuses never permit resend without explicit safe-preflight eligibility', async () => {
  for (const status of ['pending', 'preparing', 'send_started', 'accepted', 'delivered', 'failed', 'cancelled', 'uncertain']) {
    await boundary(async ({ panel, calls, respond, mount, click }) => {
      respond(() => json(record(status))); await mount();
      assert.equal(panel.button('Send payment email'), undefined, status);
      assert.equal(panel.button('Retry payment email preparation'), undefined, status); assert.equal(panel.checkbox(), undefined);
      await click('Refresh delivery status'); assert.equal(calls.every(call => call.options.method === 'GET'), true);
    });
  }
});

test('disabled configuration and unreadable status suppress sending but allow a read-only recheck', async () => {
  for (const response of [() => json({ error: 'Payment email delivery is not enabled.' }, 503),
    () => json({ notification: { id: 'notification-1', status: 'not-a-status' } }),
    () => new Response('unreadable', { status: 200 })]) await boundary(async ({ panel, calls, respond, mount, click }) => {
    respond(response); await mount(); assert.equal(panel.button('Send payment email'), undefined); assert.equal(panel.checkbox(), undefined);
    assert.equal(panel.alerts().length, 1); await click('Refresh delivery status');
    assert.equal(calls.every(call => call.options.method === 'GET'), true);
  });
});

test('a lost POST response needs a status check and never automatically repeats the send', async () => boundary(async ({ panel, calls, respond, mount, confirm, click }) => {
  respond(call => {
    if (call.options.method === 'POST') throw new Error('The send result could not be checked.');
    return json(calls.length === 1 ? { notification: null } : record('uncertain'));
  });
  await mount(); confirm(); await click('Send payment email');
  assert.equal(panel.alerts().length, 1); assert.equal(panel.button('Send payment email'), undefined);
  panel.render(); panel.flushEffects(); await flush(); assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  await click('Refresh delivery status'); assert.match(panel.text(), /send result is uncertain/);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
}));

test('retrying failed preparation requires server permission and renewed explicit confirmation', async () => {
  for (const status of ['failed', 'cancelled']) await boundary(async ({ panel, calls, respond, mount, click, confirm }) => {
    respond(call => json(call.options.method === 'GET' ? record(status, true) : record('pending'))); await mount();
    assert.match(panel.text(), /stopped before email submission/);
    assert.equal(panel.button('Send payment email'), undefined);
    assert.equal(panel.button('Retry payment email preparation').props.disabled, true);
    await click('Retry payment email preparation'); assert.equal(calls.length, 1);
    confirm(); const retry = panel.button('Retry payment email preparation').props.onClick;
    retry(); retry(); await flush(); panel.render();
    assert.equal(calls.length, 2); assert.deepEqual(JSON.parse(calls[1].options.body), { retryPreflight: true });
    assert.match(panel.text(), /Queued for delivery/); assert.equal(panel.button('Retry payment email preparation'), undefined);
  });
});

test('retry flags on submitted or uncertain states cannot enable a replacement', async () => {
  for (const status of ['accepted', 'delivered', 'uncertain', 'send_started', 'pending', 'preparing']) {
    await boundary(async ({ panel, calls, respond, mount }) => {
      respond(() => json(record(status, true))); await mount();
      assert.equal(panel.button('Retry payment email preparation'), undefined); assert.equal(panel.checkbox(), undefined);
      assert.equal(calls.filter(call => call.options.method === 'POST').length, 0);
    });
  }
});

test('refresh does not retain an earlier confirmation for a subsequent preparation attempt', async () => boundary(async ({ panel, calls, respond, mount, click, confirm }) => {
  respond(() => json(record('failed', true))); await mount(); confirm();
  assert.equal(panel.button('Retry payment email preparation').props.disabled, false);
  await click('Refresh delivery status'); assert.equal(panel.button('Retry payment email preparation').props.disabled, true);
  assert.equal(calls.every(call => call.options.method === 'GET'), true);
}));

test('late initial reads are discarded after switching reservations', async () => boundary(async ({ panel, calls, respond }) => {
  const old = deferred(); respond(call => call.url.includes('reservation-1') ? old.promise : json({ notification: null }));
  panel.flushEffects(); panel.render({ reservationId: 'reservation-2' }); panel.flushEffects(); await flush(); panel.render();
  assert.equal(calls.length, 2); assert.equal(calls[0].options.signal.aborted, true);
  old.resolve(json(record('delivered'))); await flush(); panel.render();
  assert.ok(panel.button('Send payment email')); assert.doesNotMatch(panel.text(), /reports that the email was delivered/);
  assert.equal(calls.every(call => call.options.method === 'GET'), true);
}));

test('late send outcomes cannot appear as delivery for a different reservation', async () => boundary(async ({ panel, calls, respond, mount, confirm }) => {
  const pending = deferred(); respond(call => call.options.method === 'POST' ? pending.promise : json({ notification: null }));
  await mount(); confirm(); panel.button('Send payment email').props.onClick();
  panel.render({ reservationId: 'reservation-2' }); panel.flushEffects(); await flush(); panel.render();
  pending.resolve(json(record('delivered'))); await flush(); panel.render();
  assert.ok(panel.button('Send payment email')); assert.equal(panel.button('Send payment email').props.disabled, true);
  assert.doesNotMatch(panel.text(), /reports that the email was delivered/);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
}));
