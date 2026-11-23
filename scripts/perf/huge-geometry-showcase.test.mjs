/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Showcase look of the huge-geometry generator: footage only, but a before
// clip and an after clip must show the same city on the same camera path, so
// the output must be a pure function of (elements, seed), hit the element
// budget exactly, and the ids and anchors the recorder steers by must exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const load = async (name) => { const u = new URL(name, import.meta.url); return existsSync(u) ? import(u.href) : null; };
const showcaseModule = await load('./huge-geometry-showcase.mjs');
const ladderModule = await load('./huge-geometry-ladder.mjs');
const genModule = await load('./huge-geometry-gen.mjs');
const need = (m, name) => { assert.ok(m, `scripts/perf/${name} does not exist`); return m; };
const sc = () => need(showcaseModule, 'huge-geometry-showcase.mjs');
const ladder = () => need(ladderModule, 'huge-geometry-ladder.mjs');

const render = (options) => {
  const s = ladder().resolveScenario({ look: 'showcase', ...options });
  const parts = [];
  const stats = sc().generateShowcaseModel((t) => parts.push(t), s);
  return { text: parts.join(''), stats, s };
};
const sha = (t) => createHash('sha256').update(t).digest('hex');
const ELEMENT = /^#(\d+)=IFC(SLAB|MEMBER|PLATE|COLUMN|WALL|DUCTSEGMENT|PIPESEGMENT|FURNITURE|UNITARYEQUIPMENT|GEOGRAPHICELEMENT|BUILDINGELEMENTPROXY)\('/gm;

test('showcase: same arguments give identical bytes; another seed gives another city', () => {
  const a = render({ elements: 6000 }), b = render({ elements: 6000 });
  assert.equal(sha(a.text), sha(b.text));
  assert.deepEqual(a.stats, b.stats);
  assert.notEqual(sha(render({ elements: 6000, seed: 2 }).text), sha(a.text));
});

test('showcase: writes exactly the requested element count, and the counts add up', () => {
  for (const n of [1, 5, 37, 2500, 12345]) {
    const { text, stats } = render({ elements: n });
    const ids = [...text.matchAll(ELEMENT)];
    assert.equal(ids.length, n, `elements=${n}`);
    assert.equal(stats.elements, n);
    assert.equal(Object.values(stats.perClass).reduce((x, y) => x + y, 0), n);
    assert.equal(stats.repeated + stats.unique, n);
    assert.equal(stats.repeated, [...text.matchAll(/=IFCMAPPEDITEM\(/g)].length);
    assert.match(text, /END-ISO-10303-21;\n$/);
  }
});

test('showcase: a smaller tier is a prefix of a larger one (same buildings, same hero)', () => {
  const small = render({ elements: 9000 }), big = render({ elements: 30000 });
  assert.deepEqual(small.stats.showcase.hero.ids, big.stats.showcase.hero.ids);
  assert.deepEqual(small.stats.showcase.hero.anchors, big.stats.showcase.hero.anchors);
  const names = (t, k) => [...t.matchAll(/=IFC(?!PROJECT)\w+\('[^']*',#\d+,'([^']*)'/g)].slice(0, k).map((m) => m[1]);
  assert.deepEqual(names(small.text, 8000), names(big.text, 8000));
});

test('showcase: the recorder block points at real elements with the right geometry', () => {
  const { text, stats } = render({ elements: 20000 });
  const { hero, bbox, styles, buildings } = stats.showcase;
  const elementIds = new Set([...text.matchAll(ELEMENT)].map((m) => Number(m[1])));
  for (const id of hero.ids) assert.ok(elementIds.has(id), `hero id ${id} is not an element`);
  assert.ok(hero.storey.ids.length > 20 && hero.storey.ids.every((id) => hero.ids.includes(id)));
  assert.ok(hero.anchors.length >= 4);
  assert.ok(hero.pick && elementIds.has(hero.pick.id));
  assert.equal(hero.builtFloors, hero.floors, 'the hero tower is complete at 20k');
  for (let k = 0; k < 3; k++) assert.ok(bbox.min[k] < bbox.max[k]);
  assert.ok(hero.bbox.max[2] > 100, 'the hero is a tower');
  assert.ok(buildings >= 4);
  assert.ok(styles >= 100, 'colour carries meaning: many styles');
  // Every element is contained in a storey or the site, exactly once.
  const contained = [...text.matchAll(/=IFCRELCONTAINEDINSPATIALSTRUCTURE\('[^']*',#\d+,\$,\$,\(([^)]*)\)/g)].flatMap((m) => m[1].split(',').map((x) => Number(x.slice(1))));
  assert.equal(contained.length, elementIds.size);
  assert.deepEqual(new Set(contained), elementIds);
});

test('showcase: palette is varied, not one hue', () => {
  const { colours } = sc().showcasePalette();
  const hues = new Set(colours.map(([r, g, b]) => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min < 0.15) return 'grey';
    const h = max === r ? ((g - b) / (max - min) + 6) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
    return Math.floor(h);
  }));
  assert.ok(hues.size >= 6, `only ${hues.size} hue sextants`);
});

test('showcase: spiral visits every block cell exactly once', () => {
  const seen = new Set();
  for (let n = 0; n < 2025; n++) {
    const [x, y] = sc().spiral(n);
    assert.ok(Math.max(Math.abs(x), Math.abs(y)) <= 22);
    seen.add(`${x},${y}`);
  }
  assert.equal(seen.size, 2025);
});

test('showcase: labelled, kept out of the measurement families and the ladder', () => {
  const s = ladder().resolveScenario({ look: 'showcase', elements: 1_000_000 });
  assert.equal(s.name, 'showcase-1M');
  assert.equal(s.look, 'showcase');
  assert.match(s.label, /footage only/i);
  assert.ok(!('showcase' in ladder().FAMILIES));
  assert.ok(ladder().planLadder().every((p) => p.scenario !== 'showcase'));
  assert.throws(() => ladder().resolveScenario({ look: 'showcase', elements: 10, models: 4 }), /single model/);
  assert.throws(() => ladder().resolveScenario({ look: 'showcase', elements: 10, scenario: 'mixed' }), /replaces the scenario/);
  assert.throws(() => ladder().resolveScenario({ look: 'pretty', elements: 10 }), /unknown look/);
  assert.equal(ladder().resolveScenario({ look: 'showcase', elements: 10, seed: 3 }).name, 'showcase-10-s3');
});

test('showcase: generateScenario writes a labelled manifest with the recorder block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hg-showcase-'));
  try {
    const m = need(genModule, 'huge-geometry-gen.mjs').generateScenario(dir, { look: 'showcase', elements: 3000 });
    assert.equal(m.look, 'showcase');
    assert.match(m.label, /footage only/i);
    assert.equal(m.totals.elements, 3000);
    assert.equal(m.totals.repeated + m.totals.unique, 3000);
    assert.ok(m.showcase.hero.anchors.length > 0);
    assert.equal(m.models[0].showcase, undefined);
    const text = readFileSync(m.files[0], 'latin1');
    assert.equal(sha(text), sha(render({ elements: 3000 }).text));
    assert.equal(need(genModule, 'huge-geometry-gen.mjs').generateScenario(dir, { look: 'showcase', elements: 3000 }).reused, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
