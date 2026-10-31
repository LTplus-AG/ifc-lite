/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-mesh no-worse verdicts of `mesh-census-compare.mjs` (#8190). Each
 * row pins the verdict for the one metric it changes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, compare, parseCensus } from './mesh-census-compare.mjs';

const base = {
  model: 'm.ifc', id: 7, ord: 0, type: 'IfcWall', tris: 100, open: 2, nonmanifold: 0,
  open10: 2, nonmanifold10: 0, slivers: 10, degenerate: 0, maxAspect: 100, area: 5, thinArea: 0, coincidentArea: 0,
};
const row = (patch) => ({ ...base, ...patch });

test('an unchanged mesh has no verdict', () => {
  assert.equal(classify(base, row({})), null);
});

test('gaining any edge kind is a regression', () => {
  for (const m of ['open', 'nonmanifold', 'open10', 'nonmanifold10']) {
    assert.equal(classify(base, row({ [m]: base[m] + 1 })), 'regression', m);
  }
});

test('thin material counts past 1e-6 m2 and not below', () => {
  assert.equal(classify(base, row({ thinArea: 2e-6 })), 'regression');
  assert.equal(classify(base, row({ thinArea: 5e-7 })), 'neutral');
  assert.equal(classify(base, row({ coincidentArea: 2e-6 })), 'regression');
});

test('more slivers without closing an edge is quality-worse', () => {
  assert.equal(classify(base, row({ slivers: 11 })), 'qualityWorse');
});

test('max aspect above 1.5x without closing an edge is quality-worse, at 1.5x it is not', () => {
  assert.equal(classify(base, row({ maxAspect: 151 })), 'qualityWorse');
  assert.equal(classify(base, row({ maxAspect: 150 })), 'neutral');
});

test('closing an open edge excuses more slivers', () => {
  assert.equal(classify(base, row({ open: 0, open10: 0, slivers: 40 })), 'improved');
});

test('losing thin material is an improvement', () => {
  assert.equal(classify(row({ thinArea: 2.3 }), row({ thinArea: 0, tris: 88 })), 'improved');
});

test('float metrics equal to 1e-9 relative are unchanged', () => {
  assert.equal(classify(base, row({ area: 5 * (1 + 1e-12) })), null);
  assert.equal(classify(base, row({ area: 5 * (1 + 1e-6) })), 'neutral');
});

test('a tessellation-only change is neutral', () => {
  assert.equal(classify(base, row({ tris: 102, area: 5.0000001 })), 'neutral');
});

test('a mesh missing from the branch and one added are both reported', () => {
  const a = parseCensus(`${JSON.stringify(base)}\n`);
  const b = parseCensus(`${JSON.stringify(row({ ord: 1 }))}\n`);
  const v = compare(a, b);
  assert.equal(v.missing.length, 1);
  assert.equal(v.added.length, 1);
});

test('a row missing a metric is refused, not read as neutral', () => {
  const { open, ...partial } = base;
  assert.throws(() => parseCensus(`${JSON.stringify(partial)}\n`), /missing or invalid open/);
});

test('a mesh key appearing twice is refused', () => {
  const line = JSON.stringify(base);
  assert.throws(() => parseCensus(`${line}\n${line}\n`), /appears twice/);
});
