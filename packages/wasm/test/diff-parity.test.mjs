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

// #8081: creation, validation and serialization must share the UTF-16 codec.
test('actual WASM sidecar creation and validation retain lone surrogates (#8042, #8081)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const vectors = JSON.parse(readFileSync(new URL('../../../rust/diff/tests/sidecar_parse_vectors.json', import.meta.url), 'utf8'));
  for (const vector of vectors) {
    if (vector.errorsWire === undefined) continue; // Syntax diagnostics are host-specific.
    const lineage = vector.kind === 'lineage';
    assert.equal(JSON.stringify(wasm.diffValidateSidecar(vector.text, lineage), null, 2) + '\n', vector.errorsWire, vector.name);
    if (vector.createWire !== undefined) {
      const wire = wasm.diffCreateSidecar(vector.text, lineage);
      assert.equal(wire, vector.createWire, vector.name);
      assert.deepEqual(wasm.diffValidateSidecar(wire, lineage), [], vector.name);
      assert.equal(wasm.diffSerializeSidecar(wire), wire, vector.name);
    } else {
      let caught;
      try { wasm.diffCreateSidecar(vector.text, lineage); }
      catch (error) { caught = error; }
      assert.notEqual(caught, undefined, vector.name);
      assert.equal(JSON.stringify(caught instanceof Error ? caught.message : caught), vector.createErrorJson, vector.name);
    }
  }
});

// #8081 review 4365117575: JSON.stringify escapes lone units and therefore
// cannot by itself exercise raw JS UTF-16 transport into a Rust argument.
test('actual WASM raw JSON preserves lone key/value units without collisions (#8081)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const high = '\ud800', low = '\udfff';
  const keys = [high, low, '\ufffd', '\\ud800', '\\udfff', '😀'].sort();
  function rawJson(value) {
    // Replace whole unique tokens, never the escapes of literal backslash-u.
    return JSON.stringify(value, (_, item) => item === high ? '__RAW_HIGH__' : item === low ? '__RAW_LOW__' : item)
      .replaceAll('__RAW_HIGH__', high).replaceAll('__RAW_LOW__', low);
  }
  for (const lineage of [false, true]) {
    const value = {
      format: lineage ? 'ifc-lite/lineage' : 'ifc-lite/identity-map', version: 1,
      base: { hash: high }, head: { hash: 'b', path: low },
      entries: keys.map((key, index) => lineage
        ? { base: [key], head: [`next:${index}`], relation: 'identity', reason: low }
        : { base: `source:${index}`, here: key, reason: high }),
      ...(lineage ? { deleted: [] } : {}),
    };
    const raw = rawJson(value);
    // @source-text-assertion-ok raw is locally generated JSON test input, not source-file text.
    assert.ok(raw.includes(high) && raw.includes(low), 'input contains actual unescaped code units');
    assert.deepEqual(JSON.parse(raw), value, 'host JSON oracle accepts original text');
    assert.deepEqual(wasm.diffValidateSidecar(raw, lineage), [], 'distinct keys remain distinct');
    assert.equal(wasm.diffCreateSidecar(raw, lineage), JSON.stringify(value, null, 2) + '\n');
    assert.equal(wasm.diffSerializeSidecar(raw), JSON.stringify(value, null, 2) + '\n');

    const conflict = structuredClone(value);
    conflict.entries.push(lineage
      ? { base: [high], head: ['other'], relation: 'identity', reason: 'duplicate' }
      : { base: 'other', here: high, reason: 'duplicate' });
    const diagnostic = lineage ? `base key "${high}" appears in more than one lineage entry`
      : `entries claim two different base identities for here "${high}"`;
    assert.deepEqual(wasm.diffValidateSidecar(rawJson(conflict), lineage), [diagnostic]);
    assert.throws(() => wasm.diffCreateSidecar(rawJson(conflict), lineage), error =>
      error === `Invalid ${lineage ? 'lineage' : 'identity-map'} sidecar: ${diagnostic}`);
  }
  // Arbitrary object keys also cross the serializer boundary losslessly.
  const rawObject = `{ "${high}": "${low}", "${low}": "${high}", "�": "�", "\\\\ud800": "\\\\udfff" }`;
  assert.equal(wasm.diffSerializeSidecar(rawObject), JSON.stringify(JSON.parse(rawObject), null, 2) + '\n');
});

test('actual WASM rejects invalid raw JSON before surrogate normalization (#8081)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  for (const unit of ['\ud800', '\udfff']) {
    for (const raw of [
      unit, `[${unit}]`, `{"key":${unit}}`, `{"${unit}":1,}`,
      `"\\${unit}"`, `{"key":"\\${unit}"}`, `"${unit}\n"`, `"${unit}" trailing`,
    ]) {
      assert.throws(() => JSON.parse(raw), SyntaxError, 'original host syntax is invalid');
      for (const call of [
        () => wasm.diffSerializeSidecar(raw),
        () => wasm.diffCreateSidecar(raw, false), () => wasm.diffCreateSidecar(raw, true),
        () => wasm.diffValidateSidecar(raw, false), () => wasm.diffValidateSidecar(raw, true),
      ]) assert.throws(call, SyntaxError, 'caught host parse must reject original input');
    }
  }
  // Scalar-only syntax failures keep the existing native string diagnostics.
  for (const call of [
    () => wasm.diffSerializeSidecar('{'), () => wasm.diffCreateSidecar('{', false),
    () => wasm.diffValidateSidecar('{', true),
  ]) assert.throws(call, error => typeof error === 'string');
});

// #8081 review 4365314326: typed serde strings must reject original code units
// before Rust String conversion can alias them to literal U+FFFD.
test('actual WASM staging fingerprints reject every non-scalar typed boundary (#8081)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const boundaries = value => [
    ...['ifcType', 'name', 'description', 'objectType', 'predefinedType', 'tag']
      .map(field => [field, { ifcType: 'IfcWall', [field]: value }]),
    ...['materials', 'classifications'].map(field => [field, { [field]: [value] }]),
    ...['name', 'type'].map(field => [`typeAssignments.${field}`, { typeAssignments: [{ [field]: value }] }]),
    ...[['propertySets', 'properties'], ['quantitySets', 'quantities']].flatMap(([sets, members]) => [
      [`${sets}.name`, { [sets]: [{ name: value, [members]: [] }] }],
      [`${sets}.${members}.name`, { [sets]: [{ name: 'Set', [members]: [{ name: value }] }] }],
      ...[
        ['string', value],
        ['array string', [null, [value]]],
        ['object key', { [value]: 1, '\ufffd': 2 }],
        ['nested object key', [{ outer: [{ [value]: 1 }] }]],
        ['nested object value', { outer: [false, { inner: value }] }],
        ['Map key', new Map([[value, 1], ['\ufffd', 2]])],
        ['Map value', new Map([['key', [value]]])],
      ].map(([label, item]) => [`${sets}.${members}.value ${label}`, {
        [sets]: [{ name: 'Set', [members]: [{ name: 'Entry', value: item }] }],
      }]),
    ]),
  ];
  for (const lone of ['\ud800', '\ud801', '\udfff', 'a\ud800b', '\udfff\ud800']) {
    for (const [label, input] of boundaries(lone)) {
      for (const name of ['diffBuildDataFingerprint', 'diffBuildComponentFingerprints']) {
        assert.throws(() => wasm[name](input), error => typeof error === 'string'
          && /WASM diff fingerprints require well-formed UTF-16/.test(error), `${name}: ${label}`);
      }
    }
  }
});

test('actual WASM scalar fingerprints equal the public TS engine without observing extras (#8081)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  // Root pnpm build supplies the unchanged public TS oracle, as for the
  // committed parity-vector generator. No mock or reconstructed hash oracle.
  const ts = await import('../../diff/dist/fingerprint.js');
  for (const scalar of ['\ufffd', 'é', '😀', '\ud800\udc00', 'literal\\ud800', '']) {
    const input = {
      ifcType: `IfcWall${scalar}`, name: scalar, description: scalar,
      objectType: scalar, predefinedType: scalar, tag: scalar,
      materials: [scalar], classifications: [scalar],
      typeAssignments: [{ name: scalar, type: scalar }],
      propertySets: [{ name: scalar, properties: [{ name: scalar, value: scalar },
        { name: 'nested', value: { [scalar]: [scalar, { text: scalar }], z: NaN } }] }],
      quantitySets: [{ name: scalar, quantities: [{ name: scalar, value: { [scalar]: [scalar, Infinity] } }] }],
    };
    assert.equal(wasm.diffBuildDataFingerprint(input), ts.buildDataFingerprint(input));
    assert.deepEqual(wasm.diffBuildComponentFingerprints(input), ts.buildComponentFingerprints(input));
  }
  const plain = { ifcType: 'IfcWall', typeAssignments: [{ name: 'Type', type: 'IfcWallType' }],
    propertySets: [{ name: 'Set', properties: [{ name: 'Entry', value: { text: '😀' } }] }] };
  for (const name of ['diffBuildDataFingerprint', 'diffBuildComponentFingerprints']) {
    const input = structuredClone(plain);
    let reads = 0;
    Object.defineProperty(input.propertySets[0].properties[0].value, 'text', {
      enumerable: true, get() { reads++; return '😀'; },
    });
    for (const record of [input, input.typeAssignments[0], input.propertySets[0], input.propertySets[0].properties[0]]) {
      Object.defineProperty(record, '\ud800', { enumerable: true, get() { throw new Error('ignored extra observed'); } });
    }
    Object.defineProperty(input.typeAssignments[0], 'globalId', {
      enumerable: true, get() { throw new Error('unprojected GlobalId observed'); },
    });
    assert.deepEqual(wasm[name](input), wasm[name](plain));
    assert.equal(reads, 1, `${name}: nested values are read once`);
  }
  for (const field of ['propertySets', 'quantitySets', 'typeAssignments', 'materials', 'classifications']) {
    for (const empty of [null, undefined, []]) {
      const input = { ifcType: 'IfcWall', [field]: empty };
      assert.equal(wasm.diffBuildDataFingerprint(input), ts.buildDataFingerprint(input));
      assert.deepEqual(wasm.diffBuildComponentFingerprints(input), ts.buildComponentFingerprints(input));
    }
  }
});
