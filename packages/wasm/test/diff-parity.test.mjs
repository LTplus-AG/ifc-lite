/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
          assert.equal(JSON.stringify(plain(actual)), JSON.stringify(vector.expected), `${name}: ${vector.name}: property order`);
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
// while ignoring extras; the private pre-cutover oracle supplies expectations.
test('actual WASM fingerprints preserve every lossless typed boundary (#8081)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const { loadDiffOracle } = await import('../../../scripts/lib/diff-oracle.mjs');
  const oracle = await loadDiffOracle('fingerprint');
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

test('actual WASM lossless fingerprints equal the private oracle without observing extras (#8081)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const { loadDiffOracle } = await import('../../../scripts/lib/diff-oracle.mjs');
  const ts = await loadDiffOracle('fingerprint');
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
  const { loadDiffOracle } = await import('../../../scripts/lib/diff-oracle.mjs');
  const oracle = await loadDiffOracle('fingerprint');
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
  const { loadDiffOracle } = await import('../../../scripts/lib/diff-oracle.mjs');
  const oracle = await loadDiffOracle('fingerprint');
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
async function comparisonOracle() {
  const { loadDiffOracle } = await import('../../../scripts/lib/diff-oracle.mjs');
  return loadDiffOracle('diff');
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

test('actual compareWithWasm preserves lossless constructor and option strings (#8081)', async context => {
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
      assert.deepEqual(compareWithWasm([row], []), diffModels([row], []), field);
    }
  }
  for (const scalar of ['\ud800', '\ud801', '\udfff', 'a\ud800b', '\udfff\ud800', '\ufffd', 'é', '😀', '\ud800\udc00', 'literal\\ud800', '\\udfff', '']) {
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


test('actual raw WASM component holes throw TypeError and preserve the same instance (#8042)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const { loadDiffOracle } = await import('../../../scripts/lib/diff-oracle.mjs');
  const oracle = await loadDiffOracle('fingerprint');
  const valid = { ifcType: 'IfcWall', name: '\ud800',
    propertySets: [{ name: 'P', properties: [{ name: 'value', value: 'after rejection' }] }],
    quantitySets: [{ name: 'Q', quantities: new Array(1) }],
    typeAssignments: new Array(2) };
  const expectedComponents = Object.entries(oracle.buildComponentFingerprints(valid));
  const expectedData = oracle.buildDataFingerprint(valid);
  for (const field of ['propertySets', 'quantitySets']) {
    for (const count of [1, 2]) {
      const sparse = new Array(count);
      const members = field === 'propertySets' ? 'properties' : 'quantities';
      sparse.push({ name: 'present', [members]: [] });
      assert.throws(() => wasm.diffBuildComponentFingerprints({ ifcType: 'IfcWall', [field]: sparse }),
        error => error instanceof TypeError && error.message === "Cannot read properties of undefined (reading 'name')",
        `${field}:${count}: must be a host TypeError, never a WASM panic/trap`);
      // No reinitialization: both valid operations use the instance that just
      // rejected the raw input, including successful nested sparse components.
      assert.deepEqual(Object.entries(wasm.diffBuildComponentFingerprints(valid)), expectedComponents);
      assert.equal(wasm.diffBuildDataFingerprint(valid), expectedData);
    }
  }
});

// Five locations whose elements the oracle reads `.name` from (#8042, #8114).
function sparseLocations(slots) {
  const set = (members, content) => ({ name: 'S', [members]: content });
  return [
    ['propertySets', { propertySets: slots }],
    ['quantitySets', { quantitySets: slots }],
    ['typeAssignments', { typeAssignments: slots }],
    ['properties', { propertySets: [set('properties', slots)] }],
    ['quantities', { quantitySets: [set('quantities', slots)] }],
  ];
}
function thrown(call) {
  try { call(); } catch (error) { return error; }
  return undefined;
}

test('actual raw WASM rejects present null/undefined records like the TS oracle, never as holes (#8042, #8114)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const { loadDiffOracle } = await import('../../../scripts/lib/diff-oracle.mjs');
  const oracle = await loadDiffOracle('fingerprint');
  const valid = { ifcType: 'IfcWall', name: '\ud800',
    // The literal property-member hole tests sparse recovery (#8042, #8114).
    // eslint-disable-next-line no-sparse-arrays
    propertySets: [{ name: 'P', properties: [{ name: 'value', value: 'after rejection' }, ,] }],
    quantitySets: [{ name: 'Q', quantities: new Array(1) }], typeAssignments: new Array(2) };
  const expectedData = oracle.buildDataFingerprint(valid);
  const expectedComponents = Object.entries(oracle.buildComponentFingerprints(valid));
  const present = { name: 'present', properties: [], quantities: [], type: 'IfcWallType' };
  for (const missing of [null, undefined]) {
    const label = String(missing);
    // Both literal holes distinguish absent slots from present null/undefined (#8042, #8114).
    // eslint-disable-next-line no-sparse-arrays
    for (const slots of [[missing], [present, missing], [, missing], [missing, , present]]) {
      for (const [location, fields] of sparseLocations(slots)) {
        const input = { ifcType: 'IfcWall', ...fields };
        const pairs = [['diffBuildDataFingerprint', 'buildDataFingerprint'],
          ['diffBuildComponentFingerprints', 'buildComponentFingerprints']];
        for (const [rawName, oracleName] of pairs) {
          const expected = thrown(() => oracle[oracleName](input));
          assert.ok(expected instanceof TypeError, `${location}/${label}: the oracle must reject (${rawName})`);
          const actual = thrown(() => wasm[rawName](input));
          assert.ok(actual instanceof TypeError, `${location}/${label}: ${rawName} must throw a host TypeError, got ${String(actual)}`);
          assert.equal(actual.message, expected.message, `${location}/${label}: ${rawName} message`);
          // No reinitialization: the instance that rejected the raw input still
          // serves valid sparse input byte-identically.
          assert.equal(wasm.diffBuildDataFingerprint(valid), expectedData);
          assert.deepEqual(Object.entries(wasm.diffBuildComponentFingerprints(valid)), expectedComponents);
        }
      }
    }
  }
});

test('actual raw WASM keeps absent, empty, hole and null distinct and matches TS where TS accepts (#8042, #8114)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const { loadDiffOracle } = await import('../../../scripts/lib/diff-oracle.mjs');
  const oracle = await loadDiffOracle('fingerprint');
  // One record valid in every location: set, entry and type assignment.
  const entry = { name: 'E', value: 1, properties: [], quantities: [], type: 'IfcWallType' };
  const shapes = {
    absent: () => [], empty: () => [[]], hole: () => [new Array(1)], two: () => [new Array(2)],
    // A leading literal hole is a distinct oracle collection shape (#8042, #8114).
    // eslint-disable-next-line no-sparse-arrays
    elision: () => [[, entry]], present: () => [[entry]],
  };
  for (const [location] of sparseLocations([])) {
    const hashes = new Map();
    for (const [shape, make] of Object.entries(shapes)) {
      const [slots] = make();
      // A nested set cannot be absent: the oracle requires its member array.
      if (shape === 'absent' && !['propertySets', 'quantitySets', 'typeAssignments'].includes(location)) continue;
      const fields = shape === 'absent' ? {} : Object.fromEntries(sparseLocations(slots).filter(([name]) => name === location)
        .flatMap(([, value]) => Object.entries(value)));
      const input = { ifcType: 'IfcWall', ...fields };
      const expected = oracle.buildDataFingerprint(input);
      assert.equal(wasm.diffBuildDataFingerprint(input), expected, `${location}/${shape}`);
      hashes.set(shape, expected);
      // Outer component holes are a documented raw TypeError; nested holes are valid.
      if (!['propertySets', 'quantitySets'].includes(location) || !['hole', 'two', 'elision'].includes(shape)) {
        assert.deepEqual(wasm.diffBuildComponentFingerprints(input), oracle.buildComponentFingerprints(input), `${location}/${shape}`);
      }
    }
    if (hashes.has('absent')) assert.equal(hashes.get('absent'), hashes.get('empty'), `${location}: absent and empty are equivalent`);
    assert.equal(new Set(hashes.values()).size, 5, `${location}: hole cardinality and records stay distinct`);
    for (const missing of [null, undefined]) {
      const fields = Object.fromEntries(sparseLocations([missing]).filter(([name]) => name === location)
        .flatMap(([, value]) => Object.entries(value)));
      assert.throws(() => wasm.diffBuildDataFingerprint({ ifcType: 'IfcWall', ...fields }), TypeError, `${location}: ${missing} is not a hole`);
    }
  }
  for (const field of ['propertySets', 'quantitySets', 'typeAssignments']) {
    for (const nullish of [null, undefined]) {
      const input = { ifcType: 'IfcWall', [field]: nullish };
      assert.equal(wasm.diffBuildDataFingerprint(input), oracle.buildDataFingerprint(input), `${field}: collection-level ${nullish}`);
    }
  }
});

test('actual raw WASM preserves thrown values at all five fingerprint locations (#8114)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const valid = { ifcType: 'IfcWall', propertySets: [{ name: 'P', properties: [{ name: 'a', value: 1 }] }] };
  const methods = ['diffBuildDataFingerprint', 'diffBuildComponentFingerprints'];
  const expected = methods.map(method => wasm[method](valid));
  for (const [location] of sparseLocations([])) {
    for (const raised of [new Error('original element failure'), Symbol('original failure'), 37,
      '\u0001host-type-error:spoofed', { toString() { throw new Error('must not stringify the raised value'); } }]) {
      for (const access of ['element getter', 'has trap', 'record getter']) {
        let slots = [{ name: 'ok', properties: [], quantities: [], type: 'T' }];
        if (access === 'element getter') {
          Object.defineProperty(slots, 0, { get() { throw raised; } });
        } else if (access === 'has trap') {
          slots = new Proxy(slots, { has() { throw raised; } });
        } else {
          Object.defineProperty(slots[0], 'name', { get() { throw raised; } });
        }
        const fields = sparseLocations(slots).find(([name]) => name === location)[1];
        for (const method of methods) {
          assert.strictEqual(thrown(() => wasm[method]({ ifcType: 'IfcWall', ...fields })), raised,
            `${method}/${location}/${access}: preserve the original thrown value`);
          // Reuse the initialized module after every individual rejection.
          methods.forEach((recover, index) => assert.deepEqual(wasm[recover](valid), expected[index]));
        }
      }
    }
  }
});

test('actual raw WASM checks component holes between whole collection projections (#8114)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const { loadDiffOracle } = await import('../../../scripts/lib/diff-oracle.mjs');
  const oracle = await loadDiffOracle('fingerprint');
  const valid = { ifcType: 'IfcWall', propertySets: [{ name: 'P', properties: new Array(1) }], typeAssignments: new Array(2) };
  const pairs = [['diffBuildDataFingerprint', 'buildDataFingerprint'],
    ['diffBuildComponentFingerprints', 'buildComponentFingerprints']];
  const cases = [
    // The literal outer hole tests component-versus-data rejection order (#8114).
    // eslint-disable-next-line no-sparse-arrays
    { propertySets: [,], quantitySets: [null] },
    // The literal outer hole tests component-versus-data rejection order (#8114).
    // eslint-disable-next-line no-sparse-arrays
    { quantitySets: [,], typeAssignments: [null] },
    // The literal outer hole tests rejection order before nested null (#8114).
    // eslint-disable-next-line no-sparse-arrays
    { propertySets: [,], quantitySets: [{ name: 'Q', quantities: [null] }] },
    // The complete current map runs before its holes are iterated.
    // The literal hole before null tests collection projection error precedence (#8114).
    // eslint-disable-next-line no-sparse-arrays
    { propertySets: [, null], quantitySets: [undefined] },
    // The literal hole before null tests collection projection error precedence (#8114).
    // eslint-disable-next-line no-sparse-arrays
    { quantitySets: [, null], typeAssignments: [undefined] },
    // The literal hole before a record tests nested null error precedence (#8114).
    // eslint-disable-next-line no-sparse-arrays
    { propertySets: [, { name: 'P', properties: [null] }], quantitySets: [undefined] },
    // The literal hole before a record tests nested null error precedence (#8114).
    // eslint-disable-next-line no-sparse-arrays
    { quantitySets: [, { name: 'Q', quantities: [null] }], typeAssignments: [undefined] },
  ];
  for (const [index, fields] of cases.entries()) {
    for (const [rawName, oracleName] of pairs) {
      const input = { ifcType: 'IfcWall', ...fields };
      const expected = thrown(() => oracle[oracleName](input));
      const nullWins = rawName === 'diffBuildDataFingerprint' || index >= 3;
      assert.ok(expected instanceof TypeError, `${index}/${oracleName}: oracle rejects`);
      assert.equal(expected.message, `Cannot read properties of ${nullWins ? 'null' : 'undefined'} (reading 'name')`);
      const actual = thrown(() => wasm[rawName](input));
      assert.ok(actual instanceof TypeError, `${index}/${rawName}: host TypeError`);
      assert.equal(actual.message, expected.message, `${index}/${rawName}: precedence`);
      assert.deepEqual(wasm[rawName](valid), oracle[oracleName](valid), `${index}/${rawName}: same-instance recovery`);
    }
  }
  for (const field of ['propertySets', 'quantitySets']) {
    const next = field === 'propertySets' ? 'quantitySets' : 'typeAssignments';
    for (const [rawName, oracleName] of pairs) {
      const observations = [];
      // The getter returns a literal hole to test later-field observation order (#8114).
      // eslint-disable-next-line no-sparse-arrays
      const input = { ifcType: 'IfcWall', get [field]() { observations.push(field); return [,]; },
        get [next]() { observations.push(next); return [null]; } };
      const expected = thrown(() => oracle[oracleName](input));
      const expectedReads = observations.splice(0);
      const actual = thrown(() => wasm[rawName](input));
      assert.equal(actual.message, expected.message);
      assert.deepEqual(observations, expectedReads, `${rawName}/${field}: do not observe later fields early`);
    }
  }
});

test('actual raw WASM reads one length then HasProperty before Get, without a huge upfront reserve (#8114)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const methods = ['diffBuildDataFingerprint', 'diffBuildComponentFingerprints'];
  const valid = { ifcType: 'IfcWall', name: '\ud800' };
  const expected = methods.map(method => wasm[method](valid));
  for (const [location] of sparseLocations([])) {
    for (const method of methods) {
      const record = { name: 'E', properties: [], quantities: [], type: 'T' };
      const observations = [];
      // Proxy traps must observe the literal missing index between records (#8114).
      // eslint-disable-next-line no-sparse-arrays
      const slots = new Proxy([record, , record], {
        get(target, key, receiver) {
          observations.push(`get:${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
        has(target, key) { observations.push(`has:${String(key)}`); return Reflect.has(target, key); },
      });
      const fields = sparseLocations(slots).find(([name]) => name === location)[1];
      if (method === 'diffBuildComponentFingerprints' && ['propertySets', 'quantitySets'].includes(location)) {
        assert.throws(() => wasm[method]({ ifcType: 'IfcWall', ...fields }), TypeError);
      } else {
        wasm[method]({ ifcType: 'IfcWall', ...fields });
      }
      assert.deepEqual(observations, ['get:length', 'has:0', 'get:0', 'has:1', 'has:2', 'get:2'], `${method}/${location}`);
      // Array.map's species allocation is outside the raw decoder contract.
      // Do not invoke the TS oracle on this deliberately enormous array.
      const huge = new Array(0xffff_ffff);
      huge[0] = null;
      const hugeFields = sparseLocations(huge).find(([name]) => name === location)[1];
      assert.throws(() => wasm[method]({ ifcType: 'IfcWall', ...hugeFields }),
        error => error instanceof TypeError && error.message === "Cannot read properties of null (reading 'name')",
        `${method}/${location}: invalid first record must reject before allocation`);
      methods.forEach((recover, index) => assert.deepEqual(wasm[recover](valid), expected[index]));
    }
  }
});

test('actual raw WASM catches length and revoked-array errors without poisoning later calls (#8114)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const methods = ['diffBuildDataFingerprint', 'diffBuildComponentFingerprints'];
  const valid = { ifcType: 'IfcWall' };
  const expected = methods.map(method => wasm[method](valid));
  for (const [location] of sparseLocations([])) {
    for (const method of methods) {
      for (const raised of [new Error('length failure'), Symbol('length failure')]) {
        const slots = new Proxy([], { get(target, key, receiver) {
          if (key === 'length') throw raised;
          return Reflect.get(target, key, receiver);
        } });
        const fields = sparseLocations(slots).find(([name]) => name === location)[1];
        assert.strictEqual(thrown(() => wasm[method]({ ifcType: 'IfcWall', ...fields })), raised, `${method}/${location}/length`);
        methods.forEach((recover, index) => assert.deepEqual(wasm[recover](valid), expected[index]));
      }
      const { proxy, revoke } = Proxy.revocable([], {});
      revoke();
      const fields = sparseLocations(proxy).find(([name]) => name === location)[1];
      assert.throws(() => wasm[method]({ ifcType: 'IfcWall', ...fields }), TypeError, `${method}/${location}/Array.isArray`);
      methods.forEach((recover, index) => assert.deepEqual(wasm[recover](valid), expected[index]));
    }
  }
});

test('actual raw WASM applies Array.map ToLength and ArrayCreate bounds to sparse lengths (#8114)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oraclePath = new URL('../../diff/dist/fingerprint.js', import.meta.url);
  if (!existsSync(oraclePath)) { context.skip('@ifc-lite/diff not built; run pnpm build'); return; }
  const oracle = await import(oraclePath.href);
  const pairs = [['diffBuildDataFingerprint', 'buildDataFingerprint'],
    ['diffBuildComponentFingerprints', 'buildComponentFingerprints']];
  const valid = { ifcType: 'IfcWall', propertySets: [{ name: 'P', properties: [] }] };
  const record = { name: 'E', value: 1, properties: [], quantities: [], type: 'T' };
  // Every proxy throws SENTINEL on its fourth index probe, so a uint32-wrapped
  // length stops after three holes in either implementation, never a full walk.
  const SENTINEL = Object.freeze({ sentinel: 'fourth index probe' });
  const cases = [ // [label, reported length, target slots, expected outcome, index probes]
    ['-1', () => -1, [], 'empty', 0],
    ['-1.5', () => -1.5, [], 'empty', 0],
    ['coercible -1', counts => ({ valueOf() { counts.valueOf++; return -1; } }), [], 'empty', 0],
    ['-0.5', () => -0.5, [], 'empty', 0],
    ['NaN', () => NaN, [], 'empty', 0],
    ['-Infinity', () => -Infinity, [], 'empty', 0],
    ['2^32', () => 2 ** 32, [], 'range', 0],
    ['2^32+1', () => 2 ** 32 + 1, [], 'range', 0],
    ['Infinity', () => Infinity, [], 'range', 0],
    ['2^32-1', () => 2 ** 32 - 1, [], 'sentinel', 4],
    ['1.5', () => 1.5, [record], 'parity', 2],
    ["'3'", () => '3', [], 'parity', 3],
  ];
  function outcome(call) {
    try {
      const value = call();
      return { value: typeof value === 'object' ? Object.entries(value) : value };
    } catch (error) {
      if (error === SENTINEL) return { error: 'SENTINEL' };
      return { error: error instanceof Error ? [error.constructor.name, error.message] : ['thrown', String(error)] };
    }
  }
  function observe(call, length, target) {
    const counts = { probes: 0, valueOf: 0 };
    const reported = length(counts);
    // Canonical numeric keys round-trip through Number, covering every array index.
    const index = key => typeof key === 'string' && String(Number(key)) === key;
    const probe = () => { if (++counts.probes > 3) throw SENTINEL; };
    const slots = new Proxy(target.slice(), {
      get(object, key, receiver) {
        if (key === 'length') return reported;
        if (index(key)) probe();
        return Reflect.get(object, key, receiver);
      },
      has(object, key) { if (index(key)) probe(); return Reflect.has(object, key); },
    });
    return { outcome: outcome(() => call(slots)), ...counts };
  }
  for (const [location] of sparseLocations([])) {
    const fields = slots => sparseLocations(slots).find(([name]) => name === location)[1];
    for (const [rawName, oracleName] of pairs) {
      const empty = outcome(() => wasm[rawName]({ ifcType: 'IfcWall', ...fields([]) }));
      for (const [label, length, target, kind, probes] of cases) {
        const id = `${rawName}/${location}/${label}`;
        const actual = observe(slots => wasm[rawName]({ ifcType: 'IfcWall', ...fields(slots) }), length, target);
        const expected = observe(slots => oracle[oracleName]({ ifcType: 'IfcWall', ...fields(slots) }), length, target);
        // The oracle's map also reads `constructor`; that documented non-parity is not counted.
        assert.deepEqual(actual, expected, id);
        assert.equal(actual.probes, probes, `${id}: index probes`);
        assert.equal(actual.valueOf, label === 'coercible -1' ? 1 : 0, `${id}: one length coercion`);
        if (kind === 'empty') assert.deepEqual(actual.outcome, empty, `${id}: same as an empty collection`);
        if (kind === 'range') assert.deepEqual(actual.outcome, { error: ['RangeError', 'Invalid array length'] }, id);
        if (kind === 'sentinel') assert.deepEqual(actual.outcome, { error: 'SENTINEL' }, `${id}: bounded walk parity`);
        assert.deepEqual(wasm[rawName](valid), oracle[oracleName](valid), `${id}: same-instance recovery`);
      }
    }
  }
});

function fingerprintOutcome(call) {
  try {
    const value = call();
    return { value: typeof value === 'object' ? Object.entries(value) : value };
  } catch (error) {
    return { error: error instanceof Error ? [error.constructor.name, error.message] : ['thrown', String(error)] };
  }
}

test('actual raw WASM hashes real 1e3 and 1e5 hole arrays like the oracle in constant WASM memory (#8114)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const oraclePath = new URL('../../diff/dist/fingerprint.js', import.meta.url);
  if (!existsSync(oraclePath)) { context.skip('@ifc-lite/diff not built; run pnpm build'); return; }
  const oracle = await import(oraclePath.href);
  // initSync returns the live instance's exports once initialized.
  const { memory } = wasm.initSync({ module: readFileSync(binary) });
  const pairs = [['diffBuildDataFingerprint', 'buildDataFingerprint'],
    ['diffBuildComponentFingerprints', 'buildComponentFingerprints']];
  const record = { name: 'D', value: '\ud800', properties: [], quantities: [], type: 'T' };
  const holes = (count, before = [], after = []) => {
    const values = before.slice();
    values.length += count;
    values.push(...after);
    return values;
  };
  const shapes = [count => holes(count), count => holes(count, [record]), count => holes(count, [], [record])];
  function compareAll(count) {
    let comparisons = 0;
    const compare = (id, fields) => {
      for (const [rawName, oracleName] of pairs) {
        const input = { ifcType: 'IfcWall', name: '\udc00', ...fields };
        assert.deepEqual(fingerprintOutcome(() => wasm[rawName](input)),
          fingerprintOutcome(() => oracle[oracleName](input)), `${id}/${count}/${rawName}`);
        comparisons++;
      }
    };
    for (const [location] of sparseLocations([])) {
      for (const [shape, make] of shapes.entries()) {
        compare(`${location}/${shape}`, sparseLocations(make(count)).find(([name]) => name === location)[1]);
      }
    }
    // Same-named sets reach the oracle's stableSerialize tiebreak with hole runs.
    for (const [field, members] of [['propertySets', 'properties'], ['quantitySets', 'quantities']]) {
      compare(`${field}/tiebreak`, { [field]: [{ name: 'D', [members]: holes(count, [record]) },
        { name: 'D', [members]: holes(count) }, { name: 'D', [members]: holes(count - 1, [], [record]) }] });
    }
    return comparisons;
  }
  assert.equal(compareAll(1_000), 34);
  // Identical shapes repeat the same O(present) allocations, so a hundredfold
  // hole count must not grow linear memory. Before #8114 every hole held a
  // decoder slot and a JSON value (tens of bytes each).
  const before = memory.buffer.byteLength;
  assert.equal(compareAll(100_000), 34);
  assert.equal(memory.buffer.byteLength, before, 'no per-hole WASM memory');
});

test('actual raw WASM engine-length probe matches this engine without observing String.prototype (#8114)', async context => {
  const snippets = new URL('../pkg-diff/snippets/', import.meta.url);
  if (!existsSync(snippets)) { context.skip('WASM bundle missing; run pnpm build:wasm'); return; }
  let fits;
  for (const directory of readdirSync(snippets)) {
    for (const file of readdirSync(new URL(`${directory}/`, snippets))) {
      const namespace = await import(new URL(`${directory}/${file}`, snippets).href);
      if (typeof namespace.fpStringFits === 'function') fits = namespace.fpStringFits;
    }
  }
  assert.equal(typeof fits, 'function', 'the built glue ships the length probe');
  // This engine's own maximum: bisect the lengths String.prototype.repeat
  // accepts (rope construction, no materialized text).
  let fitting = 0;
  let failing = 2 ** 53;
  while (failing - fitting > 1) {
    const middle = Math.floor((fitting + failing) / 2);
    if (thrown(() => ' '.repeat(middle)) === undefined) fitting = middle; else failing = middle;
  }
  const observed = [];
  const hooks = ['repeat', 'concat', 'padEnd', 'padStart', 'toString', 'valueOf', Symbol.toPrimitive, Symbol.iterator];
  const originals = new Map(hooks.map(key => [key, Object.getOwnPropertyDescriptor(String.prototype, key)]));
  for (const key of hooks) {
    Object.defineProperty(String.prototype, key, { configurable: true,
      get() { observed.push(String(key)); return originals.get(key)?.value; } });
  }
  let atMaximum, overMaximum, unrepresentable;
  try {
    atMaximum = thrown(() => fits(fitting));
    overMaximum = thrown(() => fits(failing));
    unrepresentable = thrown(() => fits(2 ** 64));
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(String.prototype, key, descriptor); else delete String.prototype[key];
    }
  }
  assert.deepEqual(observed, [], 'no mutable String.prototype lookup');
  assert.equal(atMaximum, undefined, 'the longest buildable string fits');
  // The oracle's stableSerialize join over holes overflows with exactly this error.
  const oracleOverflow = thrown(() => new Array(failing + 1).join(' '));
  assert.ok(oracleOverflow instanceof RangeError);
  for (const actual of [overMaximum, unrepresentable]) {
    assert.ok(actual instanceof RangeError);
    assert.equal(actual.message, oracleOverflow.message);
  }
});

test('actual raw WASM restores mode and exceptions around reentrant fingerprint calls (#8114)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const methods = ['diffBuildDataFingerprint', 'diffBuildComponentFingerprints'];
  const valid = { ifcType: 'IfcWall', propertySets: [{ name: 'P', properties: [] }] };
  const expected = methods.map(method => wasm[method](valid));
  for (const outer of methods) {
    for (const inner of methods) {
      for (const outcome of ['success', 'null record', 'uncaught getter']) {
        const sentinel = Symbol('nested getter');
        let reads = 0;
        const slots = new Array(2);
        Object.defineProperty(slots, 0, { get() {
          reads++;
          if (outcome === 'success') {
            assert.deepEqual(wasm[inner](valid), expected[methods.indexOf(inner)]);
          } else if (outcome === 'null record') {
            assert.throws(() => wasm[inner]({ ifcType: 'IfcWall', propertySets: [null] }), TypeError);
          } else {
            const record = { get name() { throw sentinel; }, properties: [] };
            assert.strictEqual(thrown(() => wasm[inner]({ ifcType: 'IfcWall', propertySets: [record] })), sentinel);
          }
          return { name: 'P', properties: [] };
        } });
        const error = thrown(() => wasm[outer]({ ifcType: 'IfcWall', propertySets: slots, quantitySets: [null] }));
        assert.ok(error instanceof TypeError, `${outer}/${inner}/${outcome}: outer error remains its own TypeError`);
        assert.equal(error.message, `Cannot read properties of ${outer === 'diffBuildDataFingerprint' ? 'null' : 'undefined'} (reading 'name')`);
        assert.equal(reads, 1, `${outer}/${inner}/${outcome}: getter observes once`);
        // With no outer error to hide a stale inner exception, the same
        // reentrant getter must also permit the outer call to succeed.
        slots.length = 1;
        assert.deepEqual(wasm[outer]({ ifcType: 'IfcWall', propertySets: slots }), expected[methods.indexOf(outer)]);
        assert.equal(reads, 2, `${outer}/${inner}/${outcome}: successful outer reads once`);
        methods.forEach((recover, index) => assert.deepEqual(wasm[recover](valid), expected[index]));
      }
    }
  }
});

test('actual raw WASM keeps one Error prefix for non-string record names (#8114)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  for (const [location] of sparseLocations([])) {
    for (const name of [42, false, {}, Symbol('invalid name')]) {
      const fields = sparseLocations([{ name, properties: [], quantities: [], type: 'T' }]).find(([key]) => key === location)[1];
      for (const method of ['diffBuildDataFingerprint', 'diffBuildComponentFingerprints']) {
        assert.strictEqual(thrown(() => wasm[method]({ ifcType: 'IfcWall', ...fields })), 'Error: expected a string', `${method}/${location}`);
        assert.equal(typeof wasm.diffBuildDataFingerprint({ ifcType: 'IfcWall' }), 'string');
      }
    }
  }
});
