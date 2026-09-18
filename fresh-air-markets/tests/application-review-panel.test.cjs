const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const appId = '11111111-1111-4111-8111-111111111111';
const application = { id: appId, sourceEventId: 'application:qa:current', reviewState: 'needs_review', reviewRevision: 0, hasOpportunity: true,
  identitySnapshot: { vendorName: 'QA Vendor', businessName: 'QA Booth', email: 'nate@autocraftstudios.com', applicantType: 'Vendor',
    category: 'Produce', dates: ['2027-05-29'], fullSeason: false, requiresFinalDateConfirmation: false, details: null } };
function harness() {
  const hooks = []; let index = 0, effects = [], tree;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const router = { replace() { throw new Error('Unexpected navigation'); } };
  const react = {
    useState(initial) { const i = index++; hooks[i] ??= { state: initial }; return [hooks[i].state, v => { hooks[i].state = typeof v === 'function' ? v(hooks[i].state) : v; }]; },
    useRef(initial) { const i = index++; hooks[i] ??= { current: initial }; return hooks[i]; },
    useCallback(callback, deps) { const i = index++; if (!hooks[i] || !same(hooks[i].deps, deps)) hooks[i] = { callback, deps }; return hooks[i].callback; },
    useEffect(effect, deps) { const i = index++; if (!hooks[i] || !same(hooks[i].deps, deps)) { hooks[i] = { deps }; effects.push(effect); } },
  };
  const filename = path.resolve(__dirname, '../src/components/ApplicationReviewPanel.tsx');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = module.paths;
  mod.require = id => id === 'react' ? react : id === 'next/navigation' ? { useRouter: () => router }
    : id === './FinalReservationPanel' || id === './ApplicationDocumentsPanel' ? { __esModule: true, default: () => null } : require(id);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, filename);
  const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
    : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join(' ');
  const all = (node, predicate) => !node || typeof node !== 'object' ? []
    : [...(predicate(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => all(child, predicate))];
  const render = () => { index = 0; tree = mod.exports.default({ applicationId: appId }); };
  render();
  return { render, flushEffects() { const pending = effects; effects = []; pending.forEach(effect => effect()); },
    text: () => text(tree), find: predicate => all(tree, predicate)[0],
    chooseCorrection() { all(tree, n => n.type === 'button' && n.props['aria-pressed'] !== undefined && text(n).startsWith('Request changes'))[0].props.onClick(); render(); },
    note(value) { all(tree, n => n.type === 'textarea')[0].props.onChange({ target: { value } }); render(); },
    async submit() { await all(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }); render(); },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function scenario(response, run, initial = application) {
  const previous = global.fetch, calls = [];
  global.fetch = async (url, options = {}) => { calls.push({ url, options }); return Response.json(options.method === 'PATCH' ? response : { application: initial }); };
  try { const panel = harness(); panel.flushEffects(); await flush(); panel.render(); await run(panel, calls); } finally { global.fetch = previous; }
}
const saved = delivery => ({ application: { id: appId, reviewState: 'changes_requested' }, reviewEventId: 'correction', duplicate: false,
  delivery, vendorNotification: 'not_sent' });

test('saving a correction reports no vendor email even when Needs Review reconciliation succeeds', async () => {
  await scenario(saved('delivered'), async (panel, calls) => {
    assert.match(panel.text(), /Record corrections; contact the vendor separately/);
    panel.chooseCorrection(); panel.note('Please correct the business name.'); await panel.submit();
    assert.match(panel.text(), /matching Needs Review state was verified/);
    assert.match(panel.text(), /No email was sent to the vendor \(email is not configured\)/);
    const patch = calls.find(c => c.options.method === 'PATCH');
    assert.deepEqual(JSON.parse(patch.options.body), { action: 'request_changes', sourceEventId: application.sourceEventId, reason: 'Please correct the business name.' });
    await panel.submit(); assert.equal(calls.filter(c => c.options.method === 'PATCH').length, 1);
  });
});

test('queued and failed CRM correction states never imply an automatic email or a successful stage update', async () => {
  for (const delivery of ['queued', 'failed']) await scenario(saved(delivery), async panel => {
    panel.chooseCorrection(); panel.note('Please correct the business name.'); await panel.submit();
    assert.match(panel.text(), /No email was sent to the vendor \(email is not configured\)/);
    assert.doesNotMatch(panel.text(), /matching CRM stage update was delivered/);
    if (delivery === 'failed') { assert.match(panel.text(), /could not be verified/); assert.doesNotMatch(panel.text(), /state is queued for verification/); }
  });
});

test('a correction response missing notification disclosure is not shown as success', async () => {
  const response = saved('delivered'); delete response.vendorNotification;
  await scenario(response, async panel => {
    panel.chooseCorrection(); panel.note('Please correct the business name.'); await panel.submit();
    assert.match(panel.text(), /review could not be saved/);
    assert.doesNotMatch(panel.text(), /matching Needs Review state was verified/);
  });
});

test('a correction waiting on the vendor is locked and says so; a re-submitted one is reviewable and says the vendor updated it', async () => {
  await scenario(saved('delivered'), async (panel, calls) => {
    assert.match(panel.text(), /Waiting for their updated application/);
    assert.match(panel.text(), /the vendor was emailed your note/);
    assert.doesNotMatch(panel.text(), /does not send a vendor email/);
    panel.chooseCorrection(); panel.note('Anything'); await panel.submit();
    assert.equal(calls.filter(c => c.options.method === 'PATCH').length, 0);
  }, { ...application, reviewState: 'changes_requested', updatedSinceReview: false, submittedAt: '2026-09-15T22:50:33.799Z' });
  await scenario(saved('delivered'), async (panel, calls) => {
    assert.match(panel.text(), /The vendor sent an updated application\s+on Sep 17, 2026/);
    assert.doesNotMatch(panel.text(), /Waiting for their updated application/);
    panel.chooseCorrection(); panel.note('One more thing.'); await panel.submit();
    assert.equal(calls.filter(c => c.options.method === 'PATCH').length, 1);
  }, { ...application, reviewState: 'changes_requested', updatedSinceReview: true, submittedAt: '2026-09-17T19:39:58.681Z' });
});

test('a stale-source refusal reloads the current submission instead of leaving a dead-end error', async () => {
  const previous = global.fetch; const calls = [];
  const newer = { ...application, sourceEventId: 'application:qa:newer', updatedSinceReview: true, submittedAt: '2026-09-17T19:39:58.681Z' };
  let loads = 0;
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'PATCH') return Response.json({ error: 'The vendor updated this application after the page was opened. It has been reloaded; check the updated details and decide again.', code: 'stale_source' }, { status: 409 });
    loads++; return Response.json({ application: loads === 1 ? application : newer });
  };
  try {
    const panel = harness(); panel.flushEffects(); await flush(); panel.render();
    await panel.submit();
    assert.equal(loads, 2);
    assert.match(panel.text(), /updated this application after the page was opened/);
    assert.match(panel.text(), /application:qa:newer/);
  } finally { global.fetch = previous; }
});


test('unknown stored CRM status preserves the saved correction and never claims queued recovery or delivery', async () => {
  await scenario(saved('unknown'), async panel => {
    panel.chooseCorrection(); panel.note('Please correct the business name.'); await panel.submit();
    assert.match(panel.text(), /decision was saved, but its CRM delivery status could not be checked/);
    assert.match(panel.text(), /No email was sent to the vendor/);
    assert.doesNotMatch(panel.text(), /state is queued for verification|stage update was delivered/);
  });
});
