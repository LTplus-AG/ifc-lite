/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Huge-geometry stress generator: a ladder that changes between runs measures
// nothing, so output must be a pure function of the arguments; element counts,
// federation slicing, the instanced/unique split and mesh triangle counts are
// what the harness reports against, so each is checked on the written STEP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Guarded loads (see gen-dense-ifc.test.mjs): a removed module fails assertions, not the file load.
const load = async (name) => { const u = new URL(name, import.meta.url); return existsSync(u) ? import(u.href) : null; };
const genModule = await load('./huge-geometry-gen.mjs');
const ladderModule = await load('./huge-geometry-ladder.mjs');
const shapesModule = await load('./huge-geometry-shapes.mjs');
const need = (m, name) => { assert.ok(m, `scripts/perf/${name} does not exist`); return m; };
const gen = () => need(genModule, 'huge-geometry-gen.mjs');
const ladder = () => need(ladderModule, 'huge-geometry-ladder.mjs');

const render = (options, m = 0) => {
  const s = ladder().resolveScenario(options);
  const parts = [];
  const stats = gen().generateHugeModel((t) => parts.push(t), s, m);
  return { text: parts.join(''), stats, s };
};
const sha = (t) => createHash('sha256').update(t).digest('hex');
const count = (text, re) => (text.match(re) ?? []).length;
const ELEMENT = /=IFC(SLAB|COLUMN|WALL|FURNITURE|BUILDINGELEMENTPROXY)\('/g;

test('same arguments give byte-identical models for every family; another seed does not', () => {
  for (const scenario of Object.keys(ladder().FAMILIES)) {
    const a = render({ scenario, elements: 400 }), b = render({ scenario, elements: 400 });
    assert.equal(sha(a.text), sha(b.text), `${scenario}: two runs differ`);
    assert.notEqual(sha(render({ scenario, elements: 400, seed: 2 }).text), sha(a.text), `${scenario}: seed ignored`);
  }
});

test('a model holds exactly the requested elements, and voided walls their openings', () => {
  for (const scenario of ['small-repeated', 'small-unique', 'mixed', 'mixed-campus']) {
    const { text, stats } = render({ scenario, elements: 1234 });
    assert.equal(count(text, ELEMENT), 1234, scenario);
    assert.equal(stats.elements, 1234);
    assert.equal(stats.perPart.reduce((a, p) => a + p.elements, 0), 1234);
    assert.equal(count(text, /=IFCOPENINGELEMENT\(/g), stats.openings);
    assert.equal(count(text, /=IFCRELVOIDSELEMENT\(/g), stats.openings);
    assert.match(text, /END-ISO-10303-21;\n$/);
  }
  const dense = render({ scenario: 'dense-few', elements: 5000 });
  assert.equal(dense.s.elements, 100, 'dense-few divides the tier by 50');
  assert.equal(count(dense.text, ELEMENT), 100);
});

test('every element is contained in exactly one storey', () => {
  const { text } = render({ scenario: 'mixed-campus', elements: 4100 });
  const contained = [...text.matchAll(/IFCRELCONTAINEDINSPATIALSTRUCTURE\('[^']+',#\d+,\$,\$,\(([^)]*)\)/g)].flatMap((m) => m[1].split(','));
  assert.equal(contained.length, 4100);
  assert.equal(new Set(contained).size, 4100);
});

test('mixed shares land within 2% of their targets and parts interleave', () => {
  const { stats, s } = render({ scenario: 'mixed', elements: 20000 });
  s.parts.forEach((p, k) => assert.ok(Math.abs(stats.perPart[k].elements / 20000 - p.share) < 0.02, `part ${k}: ${stats.perPart[k].elements}`));
  const first = Array.from({ length: 20 }, (_, i) => gen().partOf(s.parts, i));
  assert.ok(new Set(first).size >= 4, 'the first 20 elements already mix the parts');
});

test('repeat=1 references prototypes only; repeat=0 writes no mapped geometry; repeat=0.5 splits evenly', () => {
  const rep = render({ scenario: 'small-repeated', elements: 1000 });
  assert.equal(count(rep.text, /=IFCMAPPEDITEM\(/g), 1000);
  assert.equal(count(rep.text, /=IFCREPRESENTATIONMAP\(/g), 16);
  assert.equal(count(rep.text, /=IFCTRIANGULATEDFACESET\(/g), 16, 'only the prototypes carry geometry');
  const uni = render({ scenario: 'small-unique', elements: 1000 });
  assert.equal(count(uni.text, /=IFCMAPPEDITEM\(/g), 0);
  assert.equal(count(uni.text, /=IFCTRIANGULATEDFACESET\(/g), 1000);
  const half = render({ scenario: 'small-unique', elements: 1000, repeat: 0.5 });
  assert.ok(Math.abs(half.stats.perPart[0].repeated - 500) <= 5, `${half.stats.perPart[0].repeated} repeated`);
});

test('mesh elements carry exactly the triangle count the manifest reports', () => {
  const grid = need(shapesModule, 'huge-geometry-shapes.mjs').meshGrid(300);
  const { text, stats } = render({ scenario: 'small-unique', elements: 50, tris: 300 });
  const faces = [...text.matchAll(/IFCTRIANGULATEDFACESET\(#\d+,\$,\.T\.,\(((?:\(\d+,\d+,\d+\),?)+)\)/g)];
  assert.equal(faces.length, 50);
  for (const f of faces) assert.equal(count(f[1], /\(\d+,\d+,\d+\)/g), grid.triangles);
  assert.equal(stats.triangles, 50 * grid.triangles);
  assert.ok(Math.abs(grid.triangles - 300) / 300 < 0.2, `meshGrid(300) gives ${grid.triangles}`);
  assert.equal(render({ scenario: 'mixed', elements: 100 }).stats.triangles, null, 'kernel-tessellated shapes make the total unknown');
});

test('a federated set is the single model sliced: same elements, unique GlobalIds', () => {
  const opts = { scenario: 'mixed-fed4', elements: 2003 };
  const s = ladder().resolveScenario(opts);
  const names = [], guids = [];
  for (let m = 0; m < s.models; m++) {
    const { text, stats } = render(opts, m);
    const [a, b] = gen().modelRange(s.elements, s.models, m);
    assert.equal(stats.elements, b - a);
    names.push(...[...text.matchAll(/,'E(\d+)',\$,\$,#/g)].map((x) => Number(x[1])));
    guids.push(...[...text.matchAll(/\('([0-9A-Za-z_$]{22})',#/g)].map((x) => x[1]));
  }
  assert.deepEqual(names.sort((x, y) => x - y), Array.from({ length: 2003 }, (_, i) => i));
  assert.equal(new Set(guids).size, guids.length, 'GlobalIds collide across the federated set');
});

test('campus spreads buildings over a km-scale grid; tower stays compact', () => {
  const { layoutOf } = gen();
  const xs = (layout) => Array.from({ length: 50 }, (_, k) => layoutOf(layout, 1_000_000, k * 20000, 1).x);
  assert.ok(Math.max(...xs('campus')) > 1000, 'campus spans more than 1 km at 1M elements');
  assert.ok(Math.max(...xs('tower')) < 600, 'tower footprint stays under 600 m at 1M elements');
});

test('scenario validation rejects bad input before any work', () => {
  const { resolveScenario } = ladder();
  assert.throws(() => resolveScenario({ scenario: 'nope', elements: 10 }), /unknown scenario/);
  assert.throws(() => resolveScenario({ scenario: 'mixed', elements: 0 }), /positive integer/);
  assert.throws(() => resolveScenario({ scenario: 'mixed', elements: 10, repeat: 2 }), /repeat/);
  assert.throws(() => resolveScenario({ scenario: 'mixed', elements: 10, layout: 'city' }), /layout/);
  assert.throws(() => resolveScenario({ scenario: 'mixed-fed4', elements: 3 }), /cannot fill/);
  assert.equal(resolveScenario({ scenario: 'mixed', elements: 250000, repeat: 0 }).name, 'mixed-250k-r0');
});

test('generateScenario writes the files and reuses an identical set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'huge-geometry-gen-'));
  try {
    const first = gen().generateScenario(dir, { scenario: 'mixed-fed4', elements: 800 });
    assert.equal(first.files.length, 4);
    assert.equal(first.totals.elements, 800);
    assert.equal(first.totals.bytes, first.files.reduce((a, f) => a + readFileSync(f).length, 0));
    assert.equal(gen().generateScenario(dir, { scenario: 'mixed-fed4', elements: 800 }).reused, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
