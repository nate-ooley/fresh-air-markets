const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// These execute the real component handlers and browser-safe view guards. Hook
// scheduling, the browser, and network are boundaries; this is not browser QA.
function sourceModule(relative, overrides = {}) {
  const filename = path.resolve(__dirname, '..', relative);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = id => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id.startsWith('@/lib/')) return sourceModule(`src/lib/${id.slice(6)}.ts`);
    if (id.startsWith('./')) return sourceModule(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(filename), `${id}.ts`)));
    return require(id);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, filename);
  return mod.exports;
}

function panelHarness() {
  const hooks = [];
  let index = 0;
  let pendingEffects = [];
  const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
  const react = {
    useState(initial) {
      const slot = index++;
      if (!hooks[slot]) hooks[slot] = { state: typeof initial === 'function' ? initial() : initial };
      return [hooks[slot].state, value => { hooks[slot].state = typeof value === 'function' ? value(hooks[slot].state) : value; }];
    },
    useRef(initial) {
      const slot = index++;
      if (!hooks[slot]) hooks[slot] = { ref: { current: initial } };
      return hooks[slot].ref;
    },
    useCallback(callback, deps) {
      const slot = index++;
      if (!hooks[slot] || !sameDeps(hooks[slot].deps, deps)) hooks[slot] = { callback, deps };
      return hooks[slot].callback;
    },
    useEffect(effect, deps) {
      const slot = index++;
      if (!hooks[slot] || !sameDeps(hooks[slot].deps, deps)) {
        const previousCleanup = hooks[slot]?.cleanup;
        hooks[slot] = { effect, deps };
        pendingEffects.push(() => {
          previousCleanup?.();
          hooks[slot].cleanup = effect();
        });
      }
    },
  };
  const component = sourceModule('src/components/VendorPaymentPanel.tsx', { react }).default;
  let tree;
  function render() {
    index = 0;
    tree = component();
    return tree;
  }
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
  return {
    render,
    flushEffects() { const pending = pendingEffects; pendingEffects = []; pending.forEach(run => run()); },
    button(label) { return all(tree, node => node.type === 'button' && text(node) === label)[0]; },
    checkoutLinks() { return all(tree, node => node.type === 'a' && text(node).includes('Continue to Square')); },
    text() { return text(tree); },
    dispose() { hooks.forEach(hook => hook?.cleanup?.()); },
  };
}

const TOKEN = 'a'.repeat(43);
const NOW = Date.parse('2026-09-30T12:00:00Z');
const pendingReservation = {
  dates: ['2026-10-03'], boothsPerMarket: 1, rateCents: 4000, totalCents: 4000,
  currency: 'USD', quoteTier: 'standard', paymentRequired: true,
  paymentDueAt: '2026-10-02T12:00:00Z', status: 'pending',
  checkoutUrl: 'https://sandbox.square.link/u/qa-test-only', environment: 'sandbox',
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
};

async function browserBoundary(suffix, run) {
  const previousWindow = Object.getOwnPropertyDescriptor(global, 'window');
  const previousFetch = global.fetch;
  const previousNow = Date.now;
  const url = new URL(`https://freshairmarketsandevents.com/vendor/payment${suffix}`);
  const historyEvents = [];
  const intervalCallbacks = new Map();
  let intervalId = 0;
  const browser = {
    location: url,
    history: { replaceState(_state, _unused, target) {
      historyEvents.push(target);
      const next = new URL(target, url);
      url.href = next.href;
    } },
    setInterval(callback) { intervalCallbacks.set(++intervalId, callback); return intervalId; },
    clearInterval(id) { intervalCallbacks.delete(id); },
  };
  Object.defineProperty(global, 'window', { configurable: true, value: browser });
  Date.now = () => NOW;
  const calls = [];
  let responder = () => { throw new Error('Unexpected fetch'); };
  global.fetch = async (endpoint, options) => {
    const call = { endpoint, options, browserUrl: url.href, historyEvents: [...historyEvents] };
    calls.push(call);
    return responder(call);
  };
  let panel;
  try {
    panel = panelHarness();
    await run({ panel, calls, url, historyEvents, respond: fn => { responder = fn; }, tick: () => intervalCallbacks.forEach(callback => callback()) });
  } finally {
    panel?.dispose();
    global.fetch = previousFetch;
    Date.now = previousNow;
    if (previousWindow) Object.defineProperty(global, 'window', previousWindow); else delete global.window;
  }
}

test('fragment initialization clears the private token before any network action and waits for deliberate opening', async () => browserBoundary(`?returned=1#token=${TOKEN}`, async ({ panel, calls, url, historyEvents }) => {
  panel.flushEffects();
  panel.render();
  await flush();
  assert.equal(calls.length, 0);
  assert.deepEqual(historyEvents, ['/vendor/payment']);
  assert.equal(url.hash, '');
  assert.equal(url.search, '');
  assert.ok(panel.button('Open my reservation'));
  assert.equal(panel.button('Refresh reservation'), undefined);
  assert.equal(panel.checkoutLinks().length, 0);
  assert.doesNotMatch(panel.text(), new RegExp(TOKEN));
}));

test('same-tick repeated opening exchanges a single-use token once and then reads its server reservation', async () => browserBoundary(`#token=${TOKEN}`, async ({ panel, calls, respond }) => {
  const access = deferred();
  respond(call => call.endpoint === '/api/vendor/access' ? access.promise : json({ reservation: pendingReservation }));
  panel.flushEffects(); panel.render();
  const click = panel.button('Open my reservation').props.onClick;
  click(); click(); click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, '/api/vendor/access');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { token: TOKEN });
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.doesNotMatch(calls[0].browserUrl, new RegExp(TOKEN));
  assert.deepEqual(calls[0].historyEvents, ['/vendor/payment']);
  access.resolve(json({ authenticated: true }));
  await flush(); panel.render();
  assert.deepEqual(calls.map(call => call.endpoint), ['/api/vendor/access', '/api/vendor/payment']);
  assert.equal(panel.button('Open my reservation'), undefined);
  assert.equal(panel.checkoutLinks().length, 1);
  assert.doesNotMatch(panel.text(), /Payment received/);
}));

test('a new invitation does not load a previous browser session until its intended exchange succeeds', async () => browserBoundary(`#token=${TOKEN}`, async ({ panel, calls, respond }) => {
  let intendedSession = false;
  let attempts = 0;
  const intendedReservation = { ...pendingReservation, dates: ['2026-10-03', '2026-10-10'], totalCents: 8000 };
  respond(call => {
    if (call.endpoint === '/api/vendor/access') {
      if (++attempts === 1) return json({ error: 'temporarily unavailable' }, 503);
      intendedSession = true;
      return json({ authenticated: true });
    }
    return json({ reservation: intendedSession ? intendedReservation : pendingReservation });
  });
  panel.flushEffects(); panel.render();
  assert.equal(panel.button('Refresh reservation'), undefined);
  assert.equal(calls.length, 0);
  panel.button('Open my reservation').props.onClick();
  await flush(); panel.render();
  assert.equal(calls.filter(call => call.endpoint === '/api/vendor/payment').length, 0);
  assert.equal(panel.button('Refresh reservation'), undefined);
  assert.doesNotMatch(panel.text(), /\$40\.00|\$80\.00/);
  panel.button('Open my reservation').props.onClick();
  await flush(); panel.render();
  assert.deepEqual(calls.map(call => call.endpoint), ['/api/vendor/access', '/api/vendor/access', '/api/vendor/payment']);
  assert.match(panel.text(), /\$80\.00/);
  assert.ok(panel.button('Refresh reservation'));
}));

test('returned=1 only reads current server status and never infers paid or automatically sends another request', async () => browserBoundary('?returned=1', async ({ panel, calls, respond, tick, url }) => {
  respond(() => json({ reservation: pendingReservation }));
  panel.flushEffects();
  await flush(); panel.render();
  assert.equal(url.search, '');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, '/api/vendor/payment');
  assert.equal(calls[0].options.method, undefined);
  assert.match(panel.text(), /Returning from checkout does not confirm payment/);
  assert.doesNotMatch(panel.text(), /Payment received/);
  assert.equal(panel.checkoutLinks().length, 1);
  tick(); tick(); panel.render();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
}));

test('paid, expired, deadline-reached and nonprofit results never render a payment checkout link', async () => {
  const variants = [
    { ...pendingReservation, status: 'paid', checkoutUrl: null },
    { ...pendingReservation, status: 'expired', paymentDueAt: new Date(NOW - 1).toISOString(), checkoutUrl: null },
    { ...pendingReservation, paymentDueAt: new Date(NOW).toISOString() },
    { ...pendingReservation, status: 'confirmed', quoteTier: 'nonprofit', rateCents: 0, totalCents: 0, paymentRequired: false, paymentDueAt: null, checkoutUrl: null, environment: null },
  ];
  for (const reservation of variants) await browserBoundary('', async ({ panel, respond, calls }) => {
    respond(() => json({ reservation }));
    panel.flushEffects(); await flush(); panel.render();
    assert.equal(panel.checkoutLinks().length, 0, reservation.status);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, '/api/vendor/payment');
    if (reservation.status === 'paid') assert.match(panel.text(), /Payment received/);
    else if (reservation.status === 'confirmed') assert.match(panel.text(), /No payment is required/);
    else assert.match(panel.text(), /payment window has ended/);
  });
});

test('rapid status refreshes make one in-flight read and failed refresh removes a stale checkout link', async () => browserBoundary('', async ({ panel, calls, respond }) => {
  const refresh = deferred();
  respond(() => calls.length === 1 ? json({ reservation: pendingReservation }) : refresh.promise);
  panel.flushEffects(); await flush(); panel.render();
  assert.equal(panel.checkoutLinks().length, 1);
  const click = panel.button('Refresh reservation').props.onClick;
  click(); click(); click(); click(); click();
  assert.equal(calls.length, 2);
  panel.render();
  assert.equal(panel.checkoutLinks().length, 0);
  refresh.resolve(json({ error: 'temporary outage' }, 503));
  await flush(); panel.render();
  assert.equal(panel.checkoutLinks().length, 0);
  assert.match(panel.text(), /temporarily unavailable/);
  assert.equal(calls.every(call => call.endpoint === '/api/vendor/payment'), true);
}));

test('malformed fragments make no request and an expired invitation is never automatically retried or replaced', async () => {
  await browserBoundary('#token=incomplete', async ({ panel, calls, url }) => {
    panel.flushEffects(); panel.render(); await flush();
    assert.equal(calls.length, 0);
    assert.equal(url.hash, '');
    assert.match(panel.text(), /private link is incomplete/);
    assert.equal(panel.button('Open my reservation'), undefined);
  });
  await browserBoundary(`#token=${TOKEN}`, async ({ panel, calls, respond }) => {
    respond(() => json({ error: 'expired' }, 401));
    panel.flushEffects(); panel.render();
    const click = panel.button('Open my reservation').props.onClick;
    click(); await flush(); panel.render();
    click(); await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, '/api/vendor/access');
    assert.match(panel.text(), /expired, was replaced, or was already used/);
    assert.equal(panel.checkoutLinks().length, 0);
  });
});
