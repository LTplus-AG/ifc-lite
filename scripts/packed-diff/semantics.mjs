/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';

// #8042: frozen semantic expectations, reviewed against the pre-cutover oracle.
// Never generate these from the facade under test. Also run against the oracle
// using explicit tsx loading in a DIFFERENT process from the packed consumer.
export function semantics(api, { handles = false } = {}) {
  const calls = new Set();
  const call = (name, ...args) => { calls.add(name); return api[name](...args); };
  for (const [value, expected] of [
    ['', 'cbf29ce484222325'], ['a', 'af63dc4c8601ec8c'],
    ['\ud800', 'b03bbd4c8770bfdf'], ['\udfff', 'b03d724c8773a66e'],
  ]) assert.equal(call('stableHash', value), expected);
  for (const [value, expected] of [
    [undefined, null], [NaN, 'NaN'], [Infinity, 'Infinity'], [-Infinity, '-Infinity'],
    ['\ud800', '\ud800'], [{ z: 1, a: '\udfff' }, '{"a":"\\udfff","z":1}'],
  ]) assert.deepEqual(call('normalizeValue', value), expected);

  // Canonical serialization is explicit so changing a field/default is visible.
  const input = { ifcType: 'IfcWall' };
  // These independent literal hashes are pinned below, not facade-generated.
  assert.equal(call('buildDataFingerprint', input), '1b118d505bf0308b');
  assert.deepEqual(call('buildComponentFingerprints', input), { 'attr:core': '9d4896288dd39de3' });

  const row = (key, dataHash = 'd', geometryHash = 'g') => ({
    key, ifcType: 'IfcWall', dataHash, geometryHash, ref: { opaque: Symbol(key) },
  });
  const base = [row('same'), row('change'), row('gone'), row('\ud800')];
  const head = [row('same'), row('change', 'd2', 'g2'), row('new'), row('\ud800')];
  const result = call('diffModels', base, head);
  const entries = [
    { key: 'same', state: 'unchanged', changeKinds: [], base: base[0], head: head[0] },
    { key: 'change', state: 'modified', changeKinds: ['data', 'geometry'], base: base[1], head: head[1] },
    { key: 'gone', state: 'deleted', changeKinds: [], base: base[2] },
    { key: '\ud800', state: 'unchanged', changeKinds: [], base: base[3], head: head[3] },
    { key: 'new', state: 'added', changeKinds: [], head: head[2] },
  ];
  assert.deepEqual(result, {
    scope: 'both', excludedTypes: [], entries, byKey: new Map(entries.map(e => [e.key, e])),
    counts: { added: 1, modified: 1, deleted: 1, unchanged: 2 },
  });
  result.entries.forEach(e => {
    assert.equal(result.byKey.get(e.key), e);
    if (e.base) assert.ok(base.includes(e.base));
    if (e.head) assert.ok(head.includes(e.head));
  });
  assert.deepEqual(call('diffModels', [base[1]], [head[1]], { scope: 'data' }).entries[0].changeKinds, ['data']);
  assert.deepEqual(call('diffModels', [base[1]], [head[1]], { scope: 'geometry' }).entries[0].changeKinds, ['geometry']);
  assert.deepEqual(call('diffModels', base, head, { excludeTypes: [' ifcwall '] }).counts,
    { added: 0, modified: 0, deleted: 0, unchanged: 0 });
  assert.deepEqual(call('diffModels', [row('x')], [{ ...row('x'), geometryHash: undefined }]).entries[0].changeKinds, []);

  const old = row('old'), renamed = row('renamed');
  const matched = call('diffModels', [old], [renamed], { matchUnpairedByContent: true });
  assert.deepEqual(matched.counts, { added: 0, modified: 0, deleted: 0, unchanged: 0 });
  assert.deepEqual(matched.contentMatches, [{ kind: 'renamed', tier: 'geometry-hash', dataHash: 'd', base: [old], head: [renamed] }]);
  assert.equal(matched.contentMatches[0].base[0], old);
  assert.equal(matched.contentMatches[0].head[0], renamed);
  const identity = [{ base: 'old', here: 'renamed', reason: 'content-match:renamed' }];
  assert.deepEqual(call('identityMapFromContentMatches', matched.contentMatches), identity);
  const successor = { confidence: 'footprint', base: row('before'), head: row('after'), overlap: 1, distance: 0 };
  assert.deepEqual(call('identityMapFromSuccessors', [successor]), [
    { base: 'before', here: 'after', reason: 'successor:footprint' },
  ]);
  const lineage = [{ base: ['old'], head: ['renamed'], relation: 'identity', reason: 'content-match:renamed' }];
  assert.deepEqual(call('lineageOfDiff', matched), { entries: lineage, deleted: [] });
  assert.deepEqual(call('lineageFromDiff', matched), lineage);
  assert.deepEqual(call('lineageConflicts', lineage), []);
  assert.deepEqual([...call('keyAliasesFromLineage', lineage)], [['renamed', 'old']]);
  const split = [{ base: ['wall'], head: ['p0', 'p1'], relation: 'split', reason: 'split:verified', shares: [0.75, 0.25] }];
  assert.deepEqual(call('rekeyByLineage', ['wall', 'gone', 'same'], { entries: split, deleted: ['gone'] }, 'largest-share'), [
    { key: 'wall', successors: ['p0'], relation: 'split', orphan: false },
    { key: 'gone', successors: [], orphan: true },
    { key: 'same', successors: ['same'], relation: 'unchanged', orphan: false },
  ]);

  const models = { base: { hash: 'old', path: 'before.ifc' }, head: { hash: 'new' } };
  for (const [kind, sideEntries, extras] of [
    ['IdentityMap', [...identity, ...identity], {}],
    ['Lineage', [...lineage, ...lineage], { deleted: ['z', 'a', 'z'] }],
  ]) {
    const expected = {
      format: kind === 'IdentityMap' ? 'ifc-lite/identity-map' : 'ifc-lite/lineage',
      version: 1, ...models, entries: kind === 'IdentityMap' ? identity : lineage,
      ...(kind === 'Lineage' ? { deleted: ['a', 'z'] } : {}),
    };
    const sidecar = call(`create${kind}Sidecar`, { ...models, entries: sideEntries, ...extras });
    assert.deepEqual(sidecar, expected);
    assert.deepEqual(call(`validate${kind}Sidecar`, sidecar), []);
    const text = call(`serialize${kind}Sidecar`, sidecar);
    assert.equal(text, JSON.stringify(expected, null, 2) + '\n');
    assert.deepEqual(call(`parse${kind}Sidecar`, text), expected);
    assert.throws(() => call(`parse${kind}Sidecar`, '{broken'), /not JSON/);
    assert.throws(() => call(`parse${kind}Sidecar`, '{}'), /format must be/);
    const prefix = kind === 'IdentityMap' ? 'identityMap' : 'lineage';
    assert.deepEqual(call(`${prefix}SidecarMismatches`, sidecar, models), []);
    const artifact = kind === 'IdentityMap' ? 'sidecar' : 'lineage';
    assert.deepEqual(call(`${prefix}SidecarMismatches`, sidecar, { base: { hash: 'wrong' }, head: models.head }),
      [`base model does not match the ${artifact} (${artifact} old, got wrong)`]);
    const keyed = call(`create${kind}Sidecar`, { ...models, entries: sideEntries, ...extras, keyProperty: 'Tag' });
    assert.deepEqual(keyed, { ...expected, version: 2, keyProperty: 'Tag' });
    assert.throws(() => call(`parse${kind}Sidecar`, JSON.stringify({ ...expected, version: 2 })), /requires keyProperty/);
    const lone = { ...expected, entries: kind === 'IdentityMap'
      ? [{ base: '\ud800', here: '\udfff', reason: '\ud800' }]
      : [{ base: ['\ud800'], head: ['\udfff'], relation: 'identity', reason: '\ud800' }] };
    assert.deepEqual(call(`parse${kind}Sidecar`, call(`serialize${kind}Sidecar`, lone)), lone);
    const sentinel = new RangeError('sidecar getter \ud800');
    assert.throws(() => call(`validate${kind}Sidecar`, { get format() { throw sentinel; } }), e => e === sentinel);
  }
  assert.deepEqual([...call('keyAliasesFromSidecar', { format: 'ifc-lite/identity-map', version: 1, ...models, entries: identity })], [['renamed', 'old']]);
  const aliasResult = call('diffModels', [old], [renamed], { keyAliases: new Map([['renamed', 'old']]) });
  assert.deepEqual(aliasResult.counts, { added: 0, modified: 0, deleted: 0, unchanged: 1 });
  assert.deepEqual([...aliasResult.appliedKeyAliases], [['renamed', 'old']]);
  assert.equal(aliasResult.entries[0].head, renamed);
  const handleOperations = [];
  if (handles) {
    // #8042 / #8266: the class is a runtime export, not a type-only name.
    // Both construction paths own snapshots; the private oracle has no handles.
    calls.add('DiffModelHandle');
    const left = new api.DiffModelHandle(base);
    const right = call('prepareDiffModel', head);
    try {
      assert.ok(left instanceof api.DiffModelHandle);
      assert.ok(right instanceof api.DiffModelHandle);
      assert.deepEqual(left.compare(right), result);
      assert.deepEqual(left.compare(right), call('diffModels', base, head));
      assert.notEqual(left.compare(right).entries[0].base, base[0]);
      assert.equal(left.compare(right).entries[0].base.ref, base[0].ref);
      handleOperations.push('compare');
    } finally { left.dispose(); right.dispose(); }
    left.dispose(); right.dispose();
    assert.throws(() => left.compare(right), /disposed/);
    const live = call('prepareDiffModel', []);
    try {
      assert.throws(() => left.compare(live), /disposed/);
      assert.throws(() => live.compare(right), /disposed/);
    } finally { live.dispose(); }
    handleOperations.push('dispose', 'use-after-dispose');

    const placementBase = [row('placement', 'd', 'p:before')];
    const placementHead = [row('placement', 'd', 'p:after')];
    const a = call('prepareDiffModel', placementBase);
    const b = new api.DiffModelHandle(placementHead);
    let retained;
    try {
      // Return to false after true to detect a poisoned cached snapshot.
      for (const stripPlacementGeometry of [false, true, false]) {
        const strip = rows => rows.map(r => ({ ...r, geometryHash: undefined }));
        const expectedBase = stripPlacementGeometry ? strip(placementBase) : placementBase;
        const expectedHead = stripPlacementGeometry ? strip(placementHead) : placementHead;
        const entry = { key: 'placement', state: stripPlacementGeometry ? 'unchanged' : 'modified',
          changeKinds: stripPlacementGeometry ? [] : ['geometry'], base: expectedBase[0], head: expectedHead[0] };
        const expected = { scope: 'both', excludedTypes: [], entries: [entry], byKey: new Map([['placement', entry]]),
          counts: { added: 0, modified: stripPlacementGeometry ? 0 : 1, deleted: 0, unchanged: stripPlacementGeometry ? 1 : 0 } };
        const options = { stripPlacementGeometry };
        retained = a.compare(b, options);
        assert.deepEqual(retained, expected);
        assert.deepEqual(call('diffModels', placementBase, placementHead, options), expected);
        assert.equal(retained.entries[0].base.ref, placementBase[0].ref);
      }
    } finally { a[Symbol.dispose](); b[Symbol.dispose](); }
    a[Symbol.dispose](); b.dispose();
    assert.throws(() => a.compare(b), /disposed/);
    assert.equal(retained.entries[0].base.geometryHash, 'p:before');
    handleOperations.push('Symbol.dispose');
  }
  const exportedFunctions = Object.keys(api).filter(k => typeof api[k] === 'function' && !['initDiff', 'initDiffSync'].includes(k)).sort();
  assert.deepEqual([...calls].sort(), exportedFunctions, 'every public synchronous operation must have frozen expectations');
  return { operations: [...calls].sort(), handleOperations, cases: 'frozen #8042 semantic vectors' };
}
