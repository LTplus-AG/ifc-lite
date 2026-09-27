/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SnapCandidate, Vec2 } from '../types.js';
import { closestOnSegment } from './linework.js';
import { createSemanticSource, type WallAxis } from './semantic.js';
import { query, rng } from '@/test/snap-fixture.js';

function randomWalls(seed: number, n: number): WallAxis[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const a: Vec2 = [r() * 80 - 40, r() * 80 - 40];
    const len = r() * 12;
    const ang = r() * Math.PI * 2;
    return { expressId: 1000 + i, a, b: [a[0] + len * Math.cos(ang), a[1] + len * Math.sin(ang)] };
  });
}

const key = (c: SnapCandidate) => `${c.kind}:${c.entity?.expressId}:${c.local[0].toFixed(12)},${c.local[1].toFixed(12)}`;

describe('createSemanticSource (#6232 WP3)', () => {
  it('returns exactly the wall ends, midpoints and bodies within the radius (grid index vs brute force)', () => {
    const walls = randomWalls(5, 300);
    const src = createSemanticSource({ modelId: 'm', version: () => 1, storeyId: () => 3, loadAxes: () => walls, cellSize: 0.8 });
    const r = rng(6);
    for (let k = 0; k < 300; k++) {
      const cursor: Vec2 = [r() * 90 - 45, r() * 90 - 45];
      const radius = r() * 2.5;
      const got: SnapCandidate[] = [];
      src.collect(query(cursor), radius, got);
      const want: SnapCandidate[] = [];
      const within = (p: Vec2) => Math.hypot(p[0] - cursor[0], p[1] - cursor[1]) <= radius;
      for (const w of walls) {
        const m: Vec2 = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
        const e = { modelId: 'm', expressId: w.expressId };
        if (within(w.a)) want.push({ kind: 'endpoint', local: w.a, source: 'semantic', entity: e });
        if (within(w.b)) want.push({ kind: 'endpoint', local: w.b, source: 'semantic', entity: e });
        if (within(m)) want.push({ kind: 'midpoint', local: m, source: 'semantic', entity: e });
        const c = closestOnSegment(cursor, w.a, w.b);
        if (within(c)) want.push({ kind: 'edge', local: c, source: 'semantic', entity: e });
      }
      // Bodies may over-collect (up to half a cell): the solver owns the radius.
      const gotInRange = got.filter((c) => within(c.local)).map(key).sort();
      assert.deepEqual(gotInRange, want.map(key).sort(), `query ${k}`);
      for (const c of got) if (c.kind === 'edge') assert.equal(c.guide?.kind, 'segment');
    }
  });

  it('rebuilds only when the mutation version or the storey changes', () => {
    let version = 1, storey: number | null = 3, loads = 0;
    const src = createSemanticSource({
      modelId: 'm', version: () => version, storeyId: () => storey,
      loadAxes: (id) => { loads++; return id === 3 ? [{ expressId: 1, a: [0, 0], b: [4, 0] }] : []; },
    });
    const hits = () => { const out: SnapCandidate[] = []; src.collect(query([0.1, 0]), 0.5, out); return out.length; };
    assert.ok(hits() > 0);
    hits(); hits();
    assert.equal(loads, 1, 'pointer moves do not rebuild');
    version = 2;
    hits();
    assert.equal(loads, 2);
    storey = 4;
    assert.equal(hits(), 0, 'another storey has no walls here');
    storey = null;
    assert.equal(hits(), 0);
    assert.equal(src.rebuilds(), 4);
    assert.equal(loads, 3, 'no storey loads nothing');
  });
});
