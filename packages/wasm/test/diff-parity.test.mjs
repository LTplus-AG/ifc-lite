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
function rawColumnsModel(module, columns) {
  return new module.DiffModel(columns.strings, columns.fields, columns.flags, columns.boxes,
    columns.volumes, columns.componentOffsets, columns.componentPairs);
}
function comparisonStringOptions(value) {
  return [
    ['excludeTypes', { excludeTypes: [value] }],
    ['keyAliases head', { keyAliases: [[value, 'old']] }],
    ['keyAliases base', { keyAliases: [['new', value]] }],
    ['classFamilies first', { classFamilies: [[value, 'IfcWall']] }],
    ['classFamilies later', { classFamilies: [['IfcWall', value], ['IfcDoor', value]] }],
  ];
}
function comparisonRow(value) {
  return { key: `key:${value}`, ifcType: `type:${value}`, dataHash: `data:${value}`,
    geometryHash: `geometry:${value}`, container: `container:${value}`,
    components: { [`component:${value}`]: `hash:${value}` }, ref: null };
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

// #8042/#8081: the raw typed projection preserves every original code unit
// while ignoring extras; staging's unchanged public TS engine supplies expectations.
test('actual WASM fingerprints preserve every lossless typed boundary (#8081)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oraclePath = new URL('../../diff/dist/fingerprint.js', import.meta.url);
  if (!existsSync(oraclePath)) { context.skip('@ifc-lite/diff not built; run pnpm build'); return; }
  const oracle = await import(oraclePath.href);
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
      ].map(([label, item]) => [`${sets}.${members}.value ${label}`, {
        [sets]: [{ name: 'Set', [members]: [{ name: 'Entry', value: item }] }],
      }]),
    ]),
  ];
  for (const lone of ['\ud800', '\ud801', '\udfff', 'a\ud800b', '\udfff\ud800', '\ufffd', 'literal\\ud800']) {
    for (const [label, fields] of boundaries(lone)) {
      const input = { ifcType: 'IfcWall', ...fields };
      for (const name of ['diffBuildDataFingerprint', 'diffBuildComponentFingerprints']) {
        const publicName = name === 'diffBuildDataFingerprint' ? 'buildDataFingerprint' : 'buildComponentFingerprints';
        assert.deepEqual(wasm[name](input), oracle[publicName](input), `${name}: ${label}`);
      }
    }
  }
});

test('actual WASM lossless fingerprints equal the public TS engine without observing extras (#8081)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = new URL('../../diff/dist/fingerprint.js', import.meta.url);
  if (!existsSync(oracle)) { context.skip('@ifc-lite/diff not built; run pnpm build'); return; }
  const ts = await import(oracle.href);
  for (const scalar of ['\ud800', '\udfff', 'a\ud800b', '\udfff\ud800', '\ufffd', 'é', '😀', '\ud800\udc00', 'literal\\ud800', '']) {
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
    propertySets: [{ name: 'Set', properties: [{ name: 'Entry', value: { text: '\ud800' } }] }] };
  for (const name of ['diffBuildDataFingerprint', 'diffBuildComponentFingerprints']) {
    const input = structuredClone(plain);
    let reads = 0;
    let typeReads = 0;
    Object.defineProperty(input, 'ifcType', {
      enumerable: true, get() { typeReads++; return typeReads === 1 ? 'IfcWall' : 'IfcDoor'; },
    });
    Object.defineProperty(input.propertySets[0].properties[0].value, 'text', {
      enumerable: true, get() { reads++; return '\ud800'; },
    });
    for (const record of [input, input.typeAssignments[0], input.propertySets[0], input.propertySets[0].properties[0]]) {
      Object.defineProperty(record, '\ud800', { enumerable: true, get() { throw new Error('ignored extra observed'); } });
    }
    Object.defineProperty(input.typeAssignments[0], 'globalId', {
      enumerable: true, get() { throw new Error('unprojected GlobalId observed'); },
    });
    assert.deepEqual(wasm[name](input), wasm[name](plain));
    assert.equal(reads, 1, `${name}: nested values are read once`);
    assert.equal(typeReads, 1, `${name}: known struct fields are read once`);
  }
  for (const field of ['propertySets', 'quantitySets', 'typeAssignments', 'materials', 'classifications']) {
    for (const empty of [null, undefined, []]) {
      const input = { ifcType: 'IfcWall', [field]: empty };
      assert.equal(wasm.diffBuildDataFingerprint(input), ts.buildDataFingerprint(input));
      assert.deepEqual(wasm.diffBuildComponentFingerprints(input), ts.buildComponentFingerprints(input));
    }
  }
});

test('actual WASM fingerprints distinguish lone units, replacement and literal escapes (#8081)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oraclePath = new URL('../../diff/dist/fingerprint.js', import.meta.url);
  if (!existsSync(oraclePath)) { context.skip('@ifc-lite/diff not built; run pnpm build'); return; }
  const oracle = await import(oraclePath.href);
  const values = ['\ud800', '\ud801', '\udfff', '\ufffd', 'literal\\ud800'];
  const hashes = values.map(value => {
    const input = { ifcType: 'IfcWall', name: value,
      propertySets: [{ name: value, properties: [{ name: 'nested', value: { [value]: value } }] }] };
    assert.equal(wasm.diffBuildDataFingerprint(input), oracle.buildDataFingerprint(input));
    const components = wasm.diffBuildComponentFingerprints(input);
    assert.deepEqual(Object.entries(components), Object.entries(oracle.buildComponentFingerprints(input)));
    return wasm.diffBuildDataFingerprint(input);
  });
  assert.equal(new Set(hashes).size, values.length);
});


// Maps are a raw serde transport convenience. Public normalization observes
// Object.keys(Map), so compare their raw entries with an equivalent object.
test('actual WASM raw fingerprint Map entries preserve original code units (#8081)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oraclePath = new URL('../../diff/dist/fingerprint.js', import.meta.url);
  if (!existsSync(oraclePath)) { context.skip('@ifc-lite/diff not built; run pnpm build'); return; }
  const oracle = await import(oraclePath.href);
  for (const key of ['\ud800', '\udfff', '\ufffd', 'literal\\ud800']) {
    const entries = [[key, [key, { [key]: key }]], ['other', 2]];
    const input = value => ({ ifcType: 'IfcWall', propertySets: [
      { name: 'Set', properties: [{ name: 'Entry', value }] },
    ] });
    const expected = input(Object.fromEntries(entries));
    assert.equal(wasm.diffBuildDataFingerprint(input(new Map(entries))), oracle.buildDataFingerprint(expected));
    assert.deepEqual(wasm.diffBuildComponentFingerprints(input(new Map(entries))), oracle.buildComponentFingerprints(expected));
  }
});

// #8081: all raw constructor/options strings use the final lossless transport.
function losslessInput(options) {
  const { keyAliases, ...rest } = options;
  return { ...rest, ...(keyAliases === undefined ? {} : { keyAliases: [...keyAliases] }) };
}
async function comparisonOracle(context) {
  const path = new URL('../../diff/dist/diff.js', import.meta.url);
  if (!existsSync(path)) { context.skip('@ifc-lite/diff not built; run pnpm build'); return; }
  return import(path.href);
}
// #8042/#8106: option strings must change live matching, independently of model
// strings. Keep both revisions fixed while replacing only one option endpoint.
function rawFingerprintModel(wasm, rows) {
  // Keep the staged TS adapter's UTF-16 guard. JSON string tokens give it a
  // well-formed, injective dictionary; restore originals only at the raw boundary.
  const encode = value => JSON.stringify(String(value));
  const encodedRows = rows.map(row => ({
    ...row,
    key: encode(row.key), ifcType: encode(row.ifcType), dataHash: encode(row.dataHash),
    ...(row.geometryHash === undefined ? {} : { geometryHash: encode(row.geometryHash) }),
    ...(row.container === undefined ? {} : { container: encode(row.container) }),
    ...(row.components === undefined ? {} : { components: Object.fromEntries(
      Object.entries(row.components).map(([key, hash]) => [encode(key), encode(hash)]),
    ) }),
  }));
  const columns = fingerprintColumns(encodedRows);
  return rawColumnsModel(wasm, { ...columns, strings: columns.strings.map(value => JSON.parse(value)) });
}
function compareLiveOptions(wasm, oracle, baseRows, headRows, options) {
  const expected = oracle.diffModels(baseRows, headRows, options);
  const base = rawFingerprintModel(wasm, baseRows);
  try {
    const head = rawFingerprintModel(wasm, headRows);
    try {
      const actual = restoreDiffReferences(base.compare(head, losslessInput(options)), baseRows, headRows);
      assert.deepEqual(actual, expected);
      return actual;
    } finally { head.free(); }
  } finally { base.free(); }
}
function assertLiveCounts(result, added, deleted, unchanged = 0) {
  assert.deepEqual(result.counts, { added, deleted, modified: 0, unchanged });
}
const liveOptionUnits = ['\ud800', '\ud801', '\udfff', '\ufffd', 'literal\\ud800', '😀'];
const loneOptionUnits = new Set(liveOptionUnits.slice(0, 3));
test('actual WASM live alias endpoints distinguish replacement collisions (#8042, #8106)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await comparisonOracle(context); if (!oracle) return;
  for (const value of liveOptionUnits) {
    for (const endpoint of [0, 1]) {
      // The collision controls contain U+FFFD in a model, but a lone unit only
      // in the alias. Loss in the options decoder would falsely accept it.
      for (const collision of [false, true]) {
        if (collision && !loneOptionUnits.has(value)) continue;
        const modelValue = collision ? '\ufffd' : value;
        const baseRows = [{ key: endpoint === 0 ? 'old' : modelValue,
          ifcType: 'IfcWall', dataHash: 'd', ref: null }];
        const headRows = [{ key: endpoint === 0 ? modelValue : 'new',
          ifcType: 'IfcWall', dataHash: 'd', ref: null }];
        const pair = endpoint === 0 ? [value, 'old'] : ['new', value];
        const options = { keyAliases: new Map([pair]) };
        const actual = compareLiveOptions(wasm, oracle, baseRows, headRows, options);
        const check = (result, accepted) => {
          assertLiveCounts(result, accepted ? 0 : 1, accepted ? 0 : 1, accepted ? 1 : 0);
          assert.deepEqual([...result.appliedKeyAliases], accepted ? [[headRows[0].key, baseRows[0].key]] : []);
          assert.deepEqual(result.entries.map(entry => [entry.key, entry.state]), accepted
            ? [[baseRows[0].key, 'unchanged']] : [[baseRows[0].key, 'deleted'], [headRows[0].key, 'added']]);
        };
        check(actual, !collision);
        if (loneOptionUnits.has(value)) {
          const replaced = [...pair]; replaced[endpoint] = '\ufffd';
          const mutant = compareLiveOptions(wasm, oracle, baseRows, headRows, { keyAliases: new Map([replaced]) });
          check(mutant, collision);
          assert.notDeepEqual(actual, mutant, `alias endpoint ${endpoint}: option-only replacement must change matching`);
        }
      }
    }
  }
});
function liveFamilyRow(key, ifcType, minX, maxX) {
  return { key, ifcType, dataHash: `data:${key}`, geometryHash: `geometry:${key}`,
    aabb: { min: [minX, 0, 0], max: [maxX, 1, 1] }, volume: maxX - minX, ref: null };
}
test('actual WASM live successor families preserve members and first-row precedence (#8042, #8106)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await comparisonOracle(context); if (!oracle) return;
  for (const value of liveOptionUnits) {
    const cases = [
      { families: [[value, 'IfcWall']], slot: [0, 0], accepted: true },
      { families: [['IfcWall', value]], slot: [0, 1], accepted: true },
      { families: [['IfcWall', 'IfcDoor', value]], slot: [0, 2], accepted: true },
      { families: [['IfcWall', value], ['IfcDoor', value]], slot: [0, 1], accepted: true },
      { families: [['IfcDoor', value], ['IfcWall', value]], slot: [0, 1], accepted: false },
    ];
    if (loneOptionUnits.has(value)) cases.push(
      { families: [['IfcWall', value]], slot: [0, 1], headType: '\ufffd', accepted: false },
      { families: [[value, 'IfcWall']], slot: [0, 0], baseType: '\ufffd', headType: 'IfcWall', accepted: false },
    );
    for (const item of cases) {
      const baseRows = [liveFamilyRow('b', item.baseType ?? 'IfcWall', 0, 1)];
      const headRows = [liveFamilyRow('h', item.headType ?? value, 0, 1)];
      const options = { scope: 'both', matchUnpairedByContent: true,
        detectSuccessors: true, classFamilies: item.families };
      const check = (result, accepted) => {
        assertLiveCounts(result, 1, 1);
        assert.deepEqual(result.contentMatches, [], 'distinct data/classes/geometry leave candidates live');
        assert.deepEqual(result.successors, accepted ? [{ confidence: 'footprint', base: baseRows[0],
          head: headRows[0], overlap: 1, distance: 0, crossClass: true }] : []);
      };
      const actual = compareLiveOptions(wasm, oracle, baseRows, headRows, options);
      check(actual, item.accepted);
      if (loneOptionUnits.has(value)) {
        const families = structuredClone(item.families);
        families[item.slot[0]][item.slot[1]] = '\ufffd';
        const mutant = compareLiveOptions(wasm, oracle, baseRows, headRows, { ...options, classFamilies: families });
        check(mutant, !item.accepted);
        assert.notDeepEqual(actual.successors, mutant.successors, 'one family option slot must change successor claims');
      }
    }
  }
});
test('actual WASM live split families preserve canonical and later members (#8042, #8106)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await comparisonOracle(context); if (!oracle) return;
  for (const value of liveOptionUnits) {
    for (const endpoint of [0, 1]) {
      for (const collision of [false, true]) {
        if (collision && !loneOptionUnits.has(value)) continue;
        const modelValue = collision ? '\ufffd' : value;
        const baseRows = [liveFamilyRow('whole', 'IfcWall', 0, 2)];
        const headRows = [liveFamilyRow('p1', modelValue, 0, 1), liveFamilyRow('p2', modelValue, 1, 2)];
        const family = endpoint === 0 ? [value, 'IfcWall'] : ['IfcWall', value];
        const options = { scope: 'both', matchUnpairedByContent: true,
          detectSplitMerge: true, classFamilies: [family] };
        const check = (result, accepted) => {
          assertLiveCounts(result, 2, 1);
          assert.deepEqual(result.contentMatches, [], 'split candidates survive the content pass');
          assert.deepEqual(result.splitMerges, accepted ? [{ kind: 'split', confidence: 'verified',
            whole: baseRows[0], pieces: headRows, wholeVolume: 2, piecesVolume: 2,
            volumeResidual: 0, crossClass: true }] : []);
        };
        const actual = compareLiveOptions(wasm, oracle, baseRows, headRows, options);
        check(actual, !collision);
        if (loneOptionUnits.has(value)) {
          const replaced = [...family]; replaced[endpoint] = '\ufffd';
          const mutant = compareLiveOptions(wasm, oracle, baseRows, headRows, { ...options, classFamilies: [replaced] });
          check(mutant, collision);
          assert.notDeepEqual(actual.splitMerges, mutant.splitMerges, 'one family option slot must change split claims');
        }
      }
    }
  }
});

test('actual raw WASM preserves every comparison string boundary without collisions (#8081)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await comparisonOracle(context); if (!oracle) return;
  const baseRows = [{ key: 'old', ifcType: '\ufffd', dataHash: 'd', ref: null }];
  const base = model(wasm, baseRows), head = model(wasm, []);
  try {
    for (const value of ['\ud800', '\ud801', '\udfff', 'a\ud800b', '\udfff\ud800', '\ufffd', 'literal\\ud800', '\\udfff', '😀', '']) {
      for (const [label, options] of comparisonStringOptions(value)) {
        const publicOptions = { ...options,
          ...(options.keyAliases === undefined ? {} : { keyAliases: new Map(options.keyAliases) }) };
        assert.deepEqual(restoreDiffReferences(base.compare(head, losslessInput(publicOptions)), baseRows, []),
          oracle.diffModels(baseRows, [], publicOptions), label);
      }
      const columns = fingerprintColumns([comparisonRow('scalar')]);
      const labels = ['key', 'ifcType', 'dataHash', 'geometryHash', 'container', 'component name', 'component hash'];
      assert.equal(columns.strings.length, labels.length, 'every dictionary string is covered');
      for (let index = 0; index < columns.strings.length; index++) {
        const strings = [...columns.strings]; strings[index] = value;
        const row = comparisonRow('scalar'), field = labels[index];
        if (field === 'component name') row.components = { [value]: 'hash:scalar' };
        else if (field === 'component hash') row.components = { 'component:scalar': value };
        else row[field] = value;
        const raw = rawColumnsModel(wasm, { ...columns, strings });
        try {
          assert.deepEqual(restoreDiffReferences(raw.compare(head, losslessInput({})), [row], []),
            oracle.diffModels([row], []), `dictionary ${field}`);
          const peerRows = [{ ...comparisonRow('scalar'), dataHash: 'other' }];
          const peer = model(wasm, peerRows);
          try {
            for (const options of [{}, { excludeTypes: [row.ifcType] },
              { keyAliases: new Map([[peerRows[0].key, row.key]]), matchUnpairedByContent: true }]) {
              assert.deepEqual(restoreDiffReferences(raw.compare(peer, losslessInput(options)), [row], peerRows),
                oracle.diffModels([row], peerRows, options), `dictionary comparison ${field}`);
            }
          } finally { peer.free(); }
        } finally { raw.free(); }
      }
      // Confirmed #8081 bug: lone exclusion must not alias the U+FFFD class.
      assert.equal(base.compare(head, losslessInput({ excludeTypes: [value] })).counts.deleted,
        value === '\ufffd' ? 0 : 1);
    }
  } finally { base.free(); head.free(); }
});

test('actual raw WASM decodes lossless comparison getters once (#8081)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const base = model(wasm, [{ key: 'old', ifcType: 'IfcWall', dataHash: 'd', ref: null }]);
  const head = model(wasm, [{ key: 'new', ifcType: 'IfcWall', dataHash: 'd', ref: null }]);
  try {
    const plainOptions = { excludeTypes: ['IfcDoor\ud800'], keyAliases: [['new', 'old']], classFamilies: [['IfcWall', 'IfcDoor\udfff']] };
    const options = structuredClone(plainOptions);
    const reads = new Map();
    const once = (object, key, label) => {
      const value = object[key];
      Object.defineProperty(object, key, { enumerable: true, get() {
        reads.set(label, (reads.get(label) ?? 0) + 1);
        if (reads.get(label) !== 1) throw new Error(`getter read twice: ${label}`);
        return value;
      } });
    };
    for (const key of Object.keys(options)) once(options, key, key);
    // Use an independent input to count the nested getter observations.
    const nested = structuredClone(plainOptions);
    once(nested.excludeTypes, '0', 'exclude item');
    once(nested.keyAliases[0], '0', 'alias head');
    once(nested.keyAliases[0], '1', 'alias base');
    once(nested.classFamilies[0], '0', 'family first');
    once(nested.classFamilies[0], '1', 'family second');
    // #8106: pass getter-bearing objects directly to WASM; the facade helper
    // would consume top-level getters before the decoder can observe them.
    assert.deepEqual(base.compare(head, options), base.compare(head, plainOptions));
    assert.deepEqual(base.compare(head, nested), base.compare(head, plainOptions));
    assert.equal(reads.size, 8);
    assert.ok([...reads.values()].every(count => count === 1));
    // Tuple tails, non-string items and unknown options are not names consumed
    // by options_from_document; the lossless transport preserves their values.
    assert.deepEqual(base.compare(head, {
      excludeTypes: ['IfcDoor\ud800', { unused: '\ud800' }],
      keyAliases: [['new', 'old', '\ud800']],
      classFamilies: [['IfcWall', 'IfcDoor\udfff', { unused: '\udfff' }]],
      unused: '\ud800',
    }), base.compare(head, losslessInput(plainOptions)));
  } finally { base.free(); head.free(); }
});

test('actual compareWithWasm preserves lossless options and retains the staged column guard (#8081)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oracle = await comparisonOracle(context); if (!oracle) return;
  const outputs = ['wasm-diff', 'wasm-runtime'].map(name => new URL(`../../diff/dist/${name}.js`, import.meta.url));
  if (outputs.some(path => !existsSync(path))) { context.skip('@ifc-lite/diff not built; run pnpm build'); return; }
  const [{ compareWithWasm }, { initDiffSync }] = await Promise.all(outputs.map(path => import(path.href)));
  const { diffModels } = oracle;
  initDiffSync({ module: readFileSync(binary) });
  const replacement = [{ key: 'old', ifcType: '\ufffd', dataHash: 'd', ref: null }];
  for (const lone of ['\ud800', '\ud801', '\udfff', 'a\ud800b', '\udfff\ud800']) {
    assert.equal(diffModels(replacement, [], { excludeTypes: [lone] }).counts.deleted, 1, 'confirmed TS deletion oracle');
    for (const [label, options] of comparisonStringOptions(lone)) {
      const publicOptions = { ...options,
        ...(options.keyAliases === undefined ? {} : { keyAliases: new Map(options.keyAliases) }) };
      assert.deepEqual(compareWithWasm(replacement, [], publicOptions), diffModels(replacement, [], publicOptions), label);
    }
    const columns = comparisonRow('scalar');
    for (const field of ['key', 'ifcType', 'dataHash', 'geometryHash', 'container', 'component name', 'component hash']) {
      const row = { ...columns, components: { ...columns.components } };
      if (field === 'component name') row.components = { [lone]: 'hash' };
      else if (field === 'component hash') row.components = { component: lone };
      else row[field] = lone;
      assert.throws(() => compareWithWasm([row], []), /well-formed UTF-16/, field);
    }
  }
  for (const scalar of ['\ufffd', 'é', '😀', '\ud800\udc00', 'literal\\ud800', '\\udfff', '']) {
    const row = comparisonRow(scalar);
    // Neither transport should inspect opaque adapter refs.
    Object.defineProperty(row, 'ref', { get() { throw new Error('opaque ref observed'); } });
    const baseRows = [row], headRows = [{ ...comparisonRow(scalar), key: `new:${scalar}` }];
    const options = [
      {}, ...comparisonStringOptions(scalar).map(([, value]) => value),
      { keyAliases: [[headRows[0].key, row.key]] },
      { excludeTypes: [row.ifcType] },
      { matchUnpairedByContent: true, detectSuccessors: true, classFamilies: [[row.ifcType, scalar]] },
    ];
    const base = model(wasm, baseRows), head = model(wasm, headRows);
    try {
      for (const option of options) {
        // The public API accepts a ReadonlyMap; the raw binding accepts pairs.
        const publicOption = { ...option,
          ...(option.keyAliases === undefined ? {} : { keyAliases: new Map(option.keyAliases) }),
        };
        const expected = diffModels(baseRows, headRows, publicOption);
        assert.deepEqual(compareWithWasm(baseRows, headRows, publicOption), expected);
        assert.deepEqual(restoreDiffReferences(base.compare(head, losslessInput(option)), baseRows, headRows), expected);
      }
    } finally { base.free(); head.free(); }
  }
});
