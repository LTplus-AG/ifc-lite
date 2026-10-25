/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fingerprintColumns } from '../../diff/src/wasm-columns.ts';
import { restoreDiffReferences } from '../../diff/src/wasm-result.ts';
import { casePairs, unicodeCases, unicodeRow } from './diff-runtime-unicode-vectors.mjs';

const binary = new URL('../pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../pkg-diff/ifc-lite-diff.js', import.meta.url);
const oracle = new URL('../../diff/dist/diff.js', import.meta.url);
const frozenOracleLoader = new URL('../../../scripts/lib/diff-oracle.mjs', import.meta.url);
async function engines(context) {
  const missing = [binary, glue].filter(path => !existsSync(path));
  if (!existsSync(oracle) && !existsSync(frozenOracleLoader)) missing.push(oracle);
  if (missing.length) {
    const message = 'Built diff WASM and independent TS oracle required; run pnpm build:wasm and pnpm build';
    if (process.env.IFC_LITE_REQUIRE_UNICODE_WASM === '1') assert.fail(message);
    context.skip(message); return;
  }
  const wasm = await import(glue.href);
  wasm.initSync({ module: readFileSync(binary) });
  // The exact staging base still builds its independent TS engine here. The
  // later facade source moves that same oracle behind this test-only loader.
  // Never obtain expectations from the public facade being qualified.
  const independent = existsSync(frozenOracleLoader)
    ? await (await import(frozenOracleLoader.href)).loadDiffOracle('diff') : await import(oracle.href);
  return { wasm, diffModels: independent.diffModels };
}
function model(wasm, rows, unused = []) {
  // Exercise raw UTF-16 even while the staged public column adapter rejects
  // lone units. JSON tokens are injective; restore only at the raw boundary.
  const encode = value => JSON.stringify(value);
  const columns = fingerprintColumns(rows.map(row => ({ ...row, key: encode(row.key),
    ifcType: encode(row.ifcType), dataHash: encode(row.dataHash), geometryHash: encode(row.geometryHash) })));
  return new wasm.DiffModel([...columns.strings.map(value => JSON.parse(value)), ...unused],
    columns.fields, columns.flags, columns.boxes, columns.volumes, columns.componentOffsets, columns.componentPairs);
}
function wire(result) {
  // The existing JS restoration layer and TS oracle insert object properties
  // in different orders. Canonicalize object keys only; UTF-16 strings, ordered
  // entity/claim arrays and Map iteration order must still match byte for byte.
  return JSON.stringify(result, (_, value) => value instanceof Map ? [...value]
    : value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
}
function assertResult(actual, expected, base, head, label) {
  assert.deepEqual(actual, expected, label);
  assert.equal(wire(actual), wire(expected), `${label}: canonical bytes and array/Map order`);
  for (const entry of actual.entries) {
    if (entry.base) assert.ok(base.includes(entry.base), `${label}: base object identity`);
    if (entry.head) assert.ok(head.includes(entry.head), `${label}: head object identity`);
    assert.equal(actual.byKey.get(entry.key), entry, `${label}: byKey entry identity`);
  }
  for (const claim of actual.successors ?? []) {
    assert.ok(base.includes(claim.base)); assert.ok(head.includes(claim.head));
  }
  for (const claim of actual.splitMerges ?? []) {
    const [wholes, pieces] = claim.kind === 'split' ? [base, head] : [head, base];
    assert.ok(wholes.includes(claim.whole));
    for (const piece of claim.pieces) assert.ok(pieces.includes(piece));
  }
}
function check(wasm, diffModels, vector, label) {
  const { base, head, options } = vector;
  const expected = diffModels(base, head, options);
  const b = model(wasm, base);
  try {
    const h = model(wasm, head);
    try {
      const actual = restoreDiffReferences(b.compare(h, options), base, head);
      assertResult(actual, expected, base, head, label);
      if (vector.deleted !== undefined) assert.equal(actual.counts.deleted, vector.deleted, label);
      if (vector.successors !== undefined) assert.equal(actual.successors.length, vector.successors, label);
      if (vector.splits !== undefined) assert.equal(actual.splitMerges.length, vector.splits, label);
      if (vector.crossClass !== undefined) {
        const claims = vector.splits === undefined ? actual.successors : actual.splitMerges;
        assert.equal(claims[0].crossClass === true, vector.crossClass, label);
      }
      return actual;
    } finally { h.free(); }
  } finally { b.free(); }
}

test('actual WASM uses runtime Unicode for keys, families, precedence, splits and crossClass (#8042)', async context => {
  const loaded = await engines(context); if (!loaded) return;
  const { wasm, diffModels } = loaded;
  context.diagnostic(`Node ${process.version}; Unicode ${process.versions.unicode}; ICU ${process.versions.icu}`);
  // On Unicode 16 this is unchanged; on Unicode 17 it maps to U+16EA0.
  // Infer all expectations from this host, including new Latin capitals.
  for (const [lower, upper] of casePairs) {
    for (const vector of unicodeCases(lower, upper)) {
      check(wasm, diffModels, vector, `${lower.codePointAt(0).toString(16)}: ${vector.name}`);
    }
  }
});

test('actual WASM normalization preserves trimmed expansions and lone UTF-16 units (#8042)', async context => {
  const loaded = await engines(context); if (!loaded) return;
  const { wasm, diffModels } = loaded;
  for (const [lower, upper] of [
    ['\ufeff\u{16ebb} \n', '\u{16ea0}'], ['\ud800\u{16ebb}\udfff', '\ud800\u{16ea0}\udfff'],
    ['\ud800a\udfff', '\ud800A\udfff'], ['ß', 'SS'], ['\ufeff ifcwall \u00a0', 'IFCWALL'],
  ]) for (const vector of unicodeCases(lower, upper)) check(wasm, diffModels, vector, vector.name);
  // These must not collapse into the replacement scalar or literal escape.
  for (const name of ['\ud800', '\udfff', '\ud800\udfff', '\ufffd', 'literal\\ud800']) {
    check(wasm, diffModels, { base: [unicodeRow('b', name)], head: [],
      options: { excludeTypes: [name] }, deleted: 0 }, 'lossless exclude equality');
    if (name !== '\ufffd') check(wasm, diffModels, { base: [unicodeRow('b', name)], head: [],
      options: { excludeTypes: ['\ufffd'] }, deleted: 1 }, 'replacement remains distinct');
  }
});

test('actual WASM intrinsic preparation is unique, per comparison, and absent on ASCII (#8042)', async context => {
  const loaded = await engines(context); if (!loaded) return;
  const { wasm } = loaded;
  const lower = '\u{16ebb}';
  const originalTrim = String.prototype.trim, originalUpper = String.prototype.toUpperCase;
  const calls = [];
  let constructing = true;
  String.prototype.trim = function () {
    assert.equal(constructing, false, 'constructors must not call string intrinsics');
    calls.push(String(this)); return originalTrim.call(this);
  };
  String.prototype.toUpperCase = function () { return originalUpper.call(this); };
  let b, h, ascii;
  try {
    b = model(wasm, Array.from({ length: 64 }, (_, i) => unicodeRow(`b${i}`, lower)), ['unused-é']);
    h = model(wasm, [unicodeRow('h', lower)]);
    ascii = model(wasm, [unicodeRow('ascii', 'IfcWall')], ['unused-é']);
    assert.equal(calls.length, 0);
    constructing = false;
    const options = { classFamilies: [[lower, lower, 'IfcWall']], excludeTypes: [lower, lower] };
    b.compare(h, options);
    assert.deepEqual(calls, [lower], 'deduplicate across both models, families and excludes');
    calls.length = 0;
    b.compare(h, options);
    assert.deepEqual(calls, [lower], 'host results are refreshed each comparison');
    calls.length = 0;
    ascii.compare(ascii, { classFamilies: [['IfcWall', 'IFCWALL']], excludeTypes: ['IfcDoor'] });
    assert.deepEqual(calls, [], 'unused non-ASCII dictionary values do not leave the ASCII fast path');
  } finally {
    String.prototype.trim = originalTrim; String.prototype.toUpperCase = originalUpper;
    b?.free(); h?.free(); ascii?.free();
  }
});

test('actual WASM catches intrinsic throws by identity and recovers on the same models (#8042)', async context => {
  const loaded = await engines(context); if (!loaded) return;
  const { wasm, diffModels } = loaded;
  const vector = unicodeCases('\u{16ebb}', '\u{16ea0}').find(item => item.name === 'successor canonical fixed point');
  const b = model(wasm, vector.base), h = model(wasm, vector.head);
  const expected = diffModels(vector.base, vector.head, vector.options);
  try {
    for (const method of ['trim', 'toUpperCase']) {
      const original = String.prototype[method];
      for (const marker of [new Error(`host ${method}`), { method }, Symbol(method), undefined]) {
        String.prototype[method] = function () { throw marker; };
        let caught = false;
        try { b.compare(h, vector.options); }
        catch (error) { caught = true; assert.equal(error, marker, 'original thrown value'); }
        finally { String.prototype[method] = original; }
        assert.equal(caught, true, 'host error must be catchable');
        const recovered = restoreDiffReferences(b.compare(h, vector.options), vector.base, vector.head);
        assertResult(recovered, expected, vector.base, vector.head, 'same-instance recovery');
      }
    }
  } finally { h.free(); b.free(); }
});

test('actual WASM input and intrinsic reentry cannot leak normalization contexts (#8042)', async context => {
  const loaded = await engines(context); if (!loaded) return;
  const { wasm, diffModels } = loaded;
  const vector = unicodeCases('\u{16ebb}', '\u{16ea0}').find(item => item.name === 'successor canonical fixed point');
  const nestedVector = unicodeCases('\ua7d3', '\ua7d2')[0];
  const b = model(wasm, vector.base), h = model(wasm, vector.head);
  const nb = model(wasm, nestedVector.base), nh = model(wasm, nestedVector.head);
  const expected = diffModels(vector.base, vector.head, vector.options);
  const nestedExpected = diffModels(nestedVector.base, nestedVector.head, nestedVector.options);
  const nested = () => assertResult(restoreDiffReferences(nb.compare(nh, nestedVector.options),
    nestedVector.base, nestedVector.head), nestedExpected, nestedVector.base, nestedVector.head, 'nested comparison');
  try {
    const marker = new Error('input getter failed');
    assert.throws(() => b.compare(h, { get classFamilies() { nested(); throw marker; } }), error => error === marker);
    const original = String.prototype.toUpperCase;
    let entered = false;
    try {
      String.prototype.toUpperCase = function () {
        if (!entered) { entered = true; nested(); }
        return original.call(this);
      };
      const actual = b.compare(h, vector.options);
      assert.equal(entered, true, 'host intrinsic reentered the same WASM instance');
      assertResult(restoreDiffReferences(actual, vector.base, vector.head), expected,
        vector.base, vector.head, 'outer comparison after reentry');
    } finally { String.prototype.toUpperCase = original; }
    const actual = b.compare(h, { get classFamilies() { nested(); return vector.options.classFamilies; },
      scope: 'both', matchUnpairedByContent: true, detectSuccessors: true });
    assertResult(restoreDiffReferences(actual, vector.base, vector.head), expected,
      vector.base, vector.head, 'input getter reentry');
  } finally { nh.free(); nb.free(); h.free(); b.free(); }
});
