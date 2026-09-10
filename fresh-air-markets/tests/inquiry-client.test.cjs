const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Exercise the actual submit handler with React/rendering and network boundaries
// replaced. These are component checks, not public-browser verification.
function submitHandler(formPatch = {}) {
  const filename = path.resolve(__dirname, '../src/components/BookingPanel.tsx');
  const states = [new Set(['2026-10-03']), { name: 'QA Nate', businessName: 'QA Citrus', email: 'nate@autocraftstudios.com', phone: '', category: 'Produce', message: '', ...formPatch }, false, '', false];
  let state = 0;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  mod.require = id => {
    if (id === 'react') return { useState: () => [states[state++], () => {}], useRef: current => ({ current }), useEffect: () => {}, useMemo: fn => fn() };
    if (id === '@/lib/types') return require('../.test-build/types.js');
    return require(id);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const element = mod.exports.default({ booth: { id: 'qa-booth', label: 'QA', zone: 'QA', pricePerDay: 40, bookedDates: [] }, weekends: [], slug: 'qa', onClose() {}, onSubmitted() {} });
  const find = node => {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'form') return node.props.onSubmit;
    for (const child of [node.props?.children].flat(Infinity)) { const found = find(child); if (found) return found; }
    return null;
  };
  const handler = find(element); assert.equal(typeof handler, 'function');
  return () => handler({ preventDefault() {} });
}

async function browserBoundary(run, blockedStorage = false) {
  const originalFetch = global.fetch;
  const priorStorage = Object.getOwnPropertyDescriptor(global, 'sessionStorage');
  const values = new Map();
  Object.defineProperty(global, 'sessionStorage', { configurable: true, value: {
    getItem(key) { if (blockedStorage) throw new Error('Unavailable'); return values.get(key); },
    setItem(key, value) { if (blockedStorage) throw new Error('Unavailable'); values.set(key, value); },
  } });
  try { await run(values); } finally {
    global.fetch = originalFetch;
    if (priorStorage) Object.defineProperty(global, 'sessionStorage', priorStorage); else delete global.sessionStorage;
  }
}

test('rapid repeated submit events produce one request while the first is in flight', async () => browserBoundary(async () => {
  let started, release;
  const reachedFetch = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  global.fetch = async () => { calls++; started(); return pending; };
  const submit = submitHandler();
  const first = submit(); const second = submit(); const third = submit();
  await reachedFetch;
  assert.equal(calls, 1);
  release(new Response('{}', { status: 201 }));
  await Promise.all([first, second, third]);
}));

test('lost-response retry and same-tab reload retain the key; edited submission gets a new key', async () => browserBoundary(async values => {
  const calls = [];
  global.fetch = async (_url, options) => {
    calls.push(options); if (calls.length === 1) throw new Error('Response lost');
    return new Response('{}', { status: 200 });
  };
  const submit = submitHandler();
  await submit(); await submit(); await submitHandler()(); await submitHandler({ businessName: 'Changed business' })();
  const keys = calls.map(c => c.headers['Idempotency-Key']);
  assert.equal(keys[0], keys[1]); assert.equal(keys[1], keys[2]); assert.notEqual(keys[2], keys[3]);
  assert.equal(calls[0].body, calls[1].body);
  assert.doesNotMatch(JSON.stringify([...values]), /nate@|QA Nate|QA Citrus|Changed business/);
}));

test('blocked session storage still retains the in-memory request key for network retry', async () => browserBoundary(async () => {
  const keys = [];
  global.fetch = async (_url, options) => { keys.push(options.headers['Idempotency-Key']); throw new Error('offline'); };
  const submit = submitHandler(); await submit(); await submit();
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
}, true));
