/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fingerprintColumns } from '../../diff/src/wasm-columns.ts';
import { restoreDiffReferences } from '../../diff/src/wasm-result.ts';

const binary = new URL('../pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../pkg-diff/ifc-lite-diff.js', import.meta.url);
async function engine(context) {
  if (!existsSync(binary) || !existsSync(glue)) {
    context.skip('WASM bundle missing; run pnpm build:wasm'); return;
  }
  const module = await import(glue.href);
  module.initSync({ module: readFileSync(binary) });
  return module;
}
function model(module, entities) {
  const c = fingerprintColumns(entities);
  return new module.DiffModel(c.strings, c.fields, c.flags, c.boxes, c.volumes, c.componentOffsets, c.componentPairs);
}
function plain(value) {
  return JSON.parse(JSON.stringify(value, (_, item) => item instanceof Map ? [...item] : item));
}
function revive(value) {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') {
    if ('$f64' in value) {
      const bytes = new ArrayBuffer(8); const view = new DataView(bytes);
      view.setBigUint64(0, BigInt(`0x${value.$f64}`)); return view.getFloat64(0);
    }
    if ('$nonfinite' in value) return Number(value.$nonfinite);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
  }
  return value;
}
test('actual WASM sidecars preserve wire bytes, validation, and host dates (#8042)', async context => {
  const module = await engine(context); if (!module) return;
  const load = name => JSON.parse(readFileSync(new URL(`../../../rust/diff/tests/${name}.json`, import.meta.url), 'utf8'));
  for (const vector of load('sidecar_vectors')) {
    assert.equal(module.diffSerializeSidecar(JSON.stringify(vector.value)), vector.wire);
    const init = structuredClone(vector.value);
    init.entries.reverse();
    if (init.entries.length) init.entries.push({ ...init.entries[0], reason: 'must not replace the first reason' });
    if (init.deleted) init.deleted = [...init.deleted].reverse().concat(init.deleted);
    init.base.extra = 'discard';
    assert.equal(module.diffCreateSidecar(JSON.stringify(init), vector.kind === 'lineage'), vector.wire);
  }
  for (const vector of load('sidecar_validation_vectors')) {
    assert.deepEqual(module.diffValidateSidecar(JSON.stringify(vector.value), vector.kind === 'lineage'), vector.errors, vector.name);
  }
  const valid = { format: 'ifc-lite/identity-map', version: 1, base: { hash: 'a' }, head: { hash: 'b' }, entries: [] };
  for (const created of ['2000', '2024-02-30', 'Fri, 23 Oct 2026 12:00:00 GMT', 'invalid', '2026-10-23T12:00:00+02:00']) {
    const errors = module.diffValidateSidecar(JSON.stringify({ ...valid, created }), false);
    assert.deepEqual(errors, Number.isFinite(Date.parse(created)) ? [] : ['created must be an ISO 8601 timestamp when present']);
  }
});
test('actual WASM fingerprints match TS bytes including non-finite adapter values (#8042)', async context => {
  const module = await engine(context); if (!module) return;
  const corpus = JSON.parse(readFileSync(new URL('../../../rust/diff/tests/fingerprint_vectors.json', import.meta.url), 'utf8'));
  for (const vector of corpus.fingerprints) {
    const input = revive(vector.input);
    assert.equal(module.diffBuildDataFingerprint(input), vector.dataHash, vector.id);
    assert.deepEqual(module.diffBuildComponentFingerprints(input), vector.components, vector.id);
  }
  const minimal = corpus.fingerprints.find(vector => vector.id === 'minimal');
  for (const key of ['propertySets', 'quantitySets', 'typeAssignments', 'materials', 'classifications']) {
    const input = { ifcType: 'IfcWall', [key]: undefined };
    assert.equal(module.diffBuildDataFingerprint(input), minimal.dataHash, `explicit undefined ${key}`);
    assert.deepEqual(module.diffBuildComponentFingerprints(input), minimal.components, `explicit undefined components ${key}`);
  }
  const units = value => Uint16Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
  for (const vector of corpus.stableHash) assert.equal(module.diffStableHash(units(vector.value)), vector.hash);
  // Measured from the original JS FNV implementation, not replacement characters.
  for (const [value, hash] of [['\ud800', 'b03bbd4c8770bfdf'], ['\udfff', 'b03d724c8773a66e'], ['a\ud800b', '74829916f0e0eeb2']]) {
    assert.equal(module.diffStableHash(units(value)), hash);
  }
});
test('actual WASM and JS column/reference transport match the TS oracle (#8042)', async context => {
  const module = await engine(context); if (!module) return;
  for (const name of ['core', 'content', 'split', 'successor', 'lineage']) {
    const cases = JSON.parse(readFileSync(new URL(`../../../rust/diff/tests/${name}_vectors.json`, import.meta.url), 'utf8'));
    for (const vector of cases) {
      const base = model(module, vector.base);
      try {
        const head = model(module, vector.head);
        try {
          assert.equal(base.entityCount, vector.base.length);
          const actual = restoreDiffReferences(base.compare(head, vector.options), vector.base, vector.head);
          assert.deepEqual(plain(actual), vector.expected, `${name}: ${vector.name}`);
        } finally { head.free(); }
      } finally { base.free(); }
    }
  }
});
test('actual WASM retains models and preserves opaque refs and bigint hashes (#8042)', async context => {
  const module = await engine(context); if (!module) return;
  const ref = { call: () => 42, symbol: Symbol('opaque') }; ref.self = ref;
  const baseRows = [{ key: 'old', ifcType: 'IfcWall', dataHash: 'd', geometryHash: 42n, ref }];
  const headRows = [{ ...baseRows[0], key: 'new', geometryHash: '42' }];
  const base = model(module, baseRows);
  try {
    const head = model(module, headRows);
    try {
      const keyed = restoreDiffReferences(base.compare(head, {}), baseRows, headRows);
      assert.equal(keyed.counts.deleted, 1); assert.equal(keyed.counts.added, 1);
      const matched = restoreDiffReferences(base.compare(head, { matchUnpairedByContent: true }), baseRows, headRows);
      assert.equal(matched.contentMatches[0].kind, 'renamed');
      assert.equal(matched.contentMatches[0].base[0], baseRows[0]);
      assert.equal(matched.contentMatches[0].head[0], headRows[0]);
      assert.equal(matched.contentMatches[0].base[0].ref, ref);
    } finally { head.free(); }
  } finally { base.free(); }
});

// #8042: diff must remain usable before and after independent geometry init.
// Loading comparison features must not add exports to the geometry engine.
test('diff owns separate memory and survives geometry initialization (#8042)', async context => {
  const diff = await engine(context); if (!diff) return;
  const base = model(diff, [{ key: 'same', ref: null, ifcType: 'IfcWall', dataHash: 'before' }]);
  const head = model(diff, [{ key: 'same', ref: null, ifcType: 'IfcWall', dataHash: 'after' }]);
  try {
    const before = base.compare(head, {});
    const geometry = await import('../pkg/ifc-lite.js');
    assert.equal(geometry.DiffModel, undefined);
    const geometryMemory = geometry.initSync({ module: readFileSync(new URL('../pkg/ifc-lite_bg.wasm', import.meta.url)) }).memory;
    const diffMemory = diff.initSync({ module: readFileSync(binary) }).memory;
    assert.notEqual(diffMemory, geometryMemory);
    assert.deepEqual(base.compare(head, {}), before);
  } finally { base.free(); head.free(); }
});
