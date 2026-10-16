const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../src/components/SaturdayPicker.tsx');
const mod = new Module(filename, module);
mod.filename = filename; mod.paths = module.paths;
mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
const { tileState } = mod.exports;

const base = { today: '2026-10-16', booked: ['2026-10-10', '2026-10-24', '2026-10-31'], blockedReason: date => date === '2026-11-14' ? 'Other booking' : null };

test('booked Saturdays look different from open ones, and the change being made shows on each tile', () => {
  const selected = ['2026-10-10', '2026-10-24', '2026-11-07'];
  const state = date => tileState(date, { ...base, selected });
  assert.equal(state('2026-10-10'), 'kept', 'already happened: locked and still charged');
  assert.equal(state('2026-10-24'), 'booked');
  assert.equal(state('2026-10-31'), 'removing');
  assert.equal(state('2026-11-07'), 'adding');
  assert.equal(state('2026-11-21'), 'open');
  assert.equal(state('2026-11-14'), 'blocked');
});

test('when adding a new booking, the vendor existing dates show as booked and cannot be touched', () => {
  const state = date => tileState(date, { ...base, lockBooked: true, selected: [...base.booked, '2026-11-07'] });
  assert.equal(state('2026-10-24'), 'kept');
  assert.equal(state('2026-10-31'), 'kept');
  assert.equal(state('2026-11-07'), 'adding');
});
