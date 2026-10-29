/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertOriginalReferences, assertDerivedClaims, derivedGeometryCases } from './diff-derived-geometry.mjs';

// #8042 / #8112: these are harness contracts, independent of the diff engine.
const row = key => ({ key, ref: { locate: () => key } });
function references() {
  const base = [row('old')], head = [row('new'), row('other')];
  const entry = { key: 'old', base: base[0], head: head[0] };
  return { base, head, actual: {
    entries: [entry], byKey: new Map([[entry.key, entry]]),
    contentMatches: [{ base: [base[0]], head: [head[0]] }],
    splitMerges: [{ kind: 'split', whole: base[0], pieces: [head[0]], excluded: head[1] }],
    successors: [{ base: base[0], head: head[0] }],
  } };
}

test('#8112 original references survive every result path, including merge orientation', () => {
  const { actual, base, head } = references();
  assertOriginalReferences(actual, base, head);
  actual.splitMerges = [{ kind: 'merge', whole: head[0], pieces: base }];
  assertOriginalReferences(actual, base, head);
});

for (const [name, replace] of [
  ['entry base', a => { a.entries[0].base = { ...a.entries[0].base }; }],
  ['entry head', a => { a.entries[0].head = { ...a.entries[0].head }; }],
  ['content base', a => { a.contentMatches[0].base[0] = { ...a.contentMatches[0].base[0] }; }],
  ['content head', a => { a.contentMatches[0].head[0] = { ...a.contentMatches[0].head[0] }; }],
  ['split whole', a => { a.splitMerges[0].whole = { ...a.splitMerges[0].whole }; }],
  ['split piece', a => { a.splitMerges[0].pieces[0] = { ...a.splitMerges[0].pieces[0] }; }],
  ['excluded piece', a => { a.splitMerges[0].excluded = { ...a.splitMerges[0].excluded }; }],
  ['successor base', a => { a.successors[0].base = { ...a.successors[0].base }; }],
  ['successor head', a => { a.successors[0].head = { ...a.successors[0].head }; }],
]) {
  test(`#8112 rejects a copied fingerprint in ${name}`, () => {
    const { actual, base, head } = references();
    replace(actual);
    assert.throws(() => assertOriginalReferences(actual, base, head), /reuse the original fingerprint/);
  });
}

test('#8112 byKey must refer to the entry itself', () => {
  const { actual, base, head } = references();
  actual.byKey.set('old', { ...actual.entries[0] });
  assert.throws(() => assertOriginalReferences(actual, base, head), { code: 'ERR_ASSERTION' });
});

function claims(kind) {
  const piece = key => ({ ...row(key), volume: 6 });
  const whole = { ...row('whole'), volume: 12 };
  const base = kind === 'merge' ? [piece('p0'), piece('p1')] : [kind === 'split' ? whole : row('whole')];
  const head = kind === 'split' ? [piece('p0'), piece('p1')] : [kind === 'merge' ? whole : row('new')];
  return { scenario: { kind, base, head }, actual: {
    contentMatches: [], counts: { added: head.length, deleted: base.length, modified: 0, unchanged: 0 },
    successors: kind === 'successor'
      ? [{ base: base[0], head: head[0], confidence: 'footprint', overlap: 1 / 1.1 }] : [],
    splitMerges: kind === 'successor' ? [] : [{ kind, confidence: 'verified',
      pieces: kind === 'split' ? head : base, wholeVolume: 12, piecesVolume: 12, volumeResidual: 0 }],
  } };
}
for (const kind of ['split', 'merge', 'successor']) {
  test(`#8112 accepts nonempty ${kind} claims and rejects lost additive entries`, () => {
    const { actual, scenario } = claims(kind);
    assertDerivedClaims(actual, scenario);
    actual.counts.added = 0;
    assert.throws(() => assertDerivedClaims(actual, scenario), /preserve all add\/delete entries/);
  });
  test(`#8112 rejects empty ${kind} claims`, () => {
    const { actual, scenario } = claims(kind);
    actual.successors = [];
    actual.splitMerges = [];
    assert.throws(() => assertDerivedClaims(actual, scenario), { code: 'ERR_ASSERTION' });
  });
}
for (const [name, corrupt] of [
  ['content consumed early', a => { a.contentMatches = [{}]; }],
  ['copied successor', a => { a.successors[0].base = { ...a.successors[0].base }; }],
  ['incorrect overlap', a => { a.successors[0].overlap = 1; }],
  ['unverified successor', a => { a.successors[0].confidence = 'guess'; }],
]) {
  test(`#8112 rejects ${name}`, () => {
    const { actual, scenario } = claims('successor');
    corrupt(actual);
    assert.throws(() => assertDerivedClaims(actual, scenario), { code: 'ERR_ASSERTION' });
  });
}
for (const [name, corrupt] of [
  ['volume residual', a => { a.splitMerges[0].volumeResidual = 1; }],
  ['unequal volumes', a => { a.splitMerges[0].piecesVolume = 11; }],
  ['volumes agreeing but not measured', a => { a.splitMerges[0].wholeVolume = 0; a.splitMerges[0].piecesVolume = 0; }],
  ['missing piece', a => { a.splitMerges[0].pieces.pop(); }],
  ['competing successor', a => { a.successors = [{}]; }],
]) {
  test(`#8112 rejects split with ${name}`, () => {
    const { actual, scenario } = claims('split');
    corrupt(actual);
    assert.throws(() => assertDerivedClaims(actual, scenario), { code: 'ERR_ASSERTION' });
  });
}

test('#8112 derived revisions preserve measured volume and disclose their synthetic provenance', () => {
  const source = { ...row('solid'), ifcType: 'IfcWall', geometryHash: 'measured',
    aabb: { min: [10, 20, 30], max: [12, 26, 33] }, volume: 9 };
  // Only data fingerprinting is injected; all affine construction is production code.
  const fingerprints = { buildDataFingerprint: JSON.stringify, buildComponentFingerprints: input => ({ core: JSON.stringify(input) }) };
  const { provenance, cases } = derivedGeometryCases([source], fingerprints);
  assert.equal(provenance.axis, 1);
  assert.strictEqual(provenance.sourceExpressId, source.ref);
  assert.equal(provenance.sourceVolume, 9);
  assert.match(provenance.kind, /not authored IFC ground truth/);
  assert.deepEqual(cases.map(c => c.name), ['derived-split', 'derived-merge', 'derived-successor', 'derived-successor-geometry-scope']);
  const [split, merge, successor, scoped] = cases;
  assert.strictEqual(merge.base, split.head);
  assert.strictEqual(merge.head[0], split.base[0]);
  assert.deepEqual(split.head.map(p => p.volume), [9, 9]);
  assert.equal(split.base[0].volume, 18);
  assert.equal(split.head[0].aabb.max[1], split.head[1].aabb.min[1]);
  assert.deepEqual(split.head[1].aabb, { min: [10, 26, 30], max: [12, 32, 33] });
  assert.equal(successor.head[0].volume, 9 * 1.1);
  assert.notEqual(successor.base[0].geometryHash, successor.head[0].geometryHash);
  assert.notEqual(successor.base[0].dataHash, successor.head[0].dataHash);
  assert.match(successor.head[0].geometryHash, /^derived:sha256:/);
  assert.strictEqual(successor.head[0].ref.locate(), source.ref);
  assert.equal(scoped.options.scope, 'geometry');
  assert.throws(() => derivedGeometryCases([{ ...source, volume: 0 }], fingerprints), /real closed solid/);
});
