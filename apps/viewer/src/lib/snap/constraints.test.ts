/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildLocus, intersectLocusWithGuide, projectOntoLocus, type Locus } from './constraints.js';
import { MODELING_SNAP_PROFILE } from './rank.js';
import type { Vec2 } from './types.js';
import { query, rng } from '@/test/snap-fixture.js';

const P = MODELING_SNAP_PROFILE;
const A: Vec2 = [2, 3];

describe('buildLocus (#6232 WP3)', () => {
  it('ignores every lock without an anchor', () => {
    const l = buildLocus(query([5, 5], { locks: { length: 2, angleDeg: 30, axis: 'u' }, modifiers: { shift: true, alt: false } }), P);
    assert.equal(l.kind, 'free');
  });

  it('typed length → circle; typed angle → ray; axis → line', () => {
    assert.deepEqual(buildLocus(query([9, 9], { anchor: A, locks: { length: 4 } }), P), { kind: 'circle', center: A, radius: 4 });
    assert.deepEqual(buildLocus(query([9, 9], { anchor: A, locks: { angleDeg: 90 } }), P), { kind: 'ray', origin: A, dir: [0, 1] });
    assert.deepEqual(buildLocus(query([9, 9], { anchor: A, locks: { axis: 'v' } }), P), { kind: 'line', origin: A, dir: [0, 1] });
  });

  it('length + angle → the exact point', () => {
    const l = buildLocus(query([0, 0], { anchor: A, locks: { length: 3.5, angleDeg: 180 } }), P);
    assert.deepEqual(l, { kind: 'point', p: [-1.5, 3] });
  });

  it('length + two-sided axis takes the side the cursor is on', () => {
    assert.deepEqual(buildLocus(query([-9, 3], { anchor: A, locks: { length: 1, axis: 'u' } }), P), { kind: 'point', p: [1, 3] });
    assert.deepEqual(buildLocus(query([9, 3], { anchor: A, locks: { length: 1, axis: 'u' } }), P), { kind: 'point', p: [3, 3] });
  });

  it('shift quantises to the profile angle step; 90° is the |dx| ≥ |dy| ortho rule', () => {
    const ortho = { ...P, angleStepDeg: 90 };
    const shift = { shift: true, alt: false };
    assert.deepEqual(buildLocus(query([6, 4], { anchor: A, modifiers: shift }), ortho), { kind: 'line', origin: A, dir: [1, 0] });
    assert.deepEqual(buildLocus(query([3, 9], { anchor: A, modifiers: shift }), ortho), { kind: 'line', origin: A, dir: [0, 1] });
    const l = buildLocus(query([A[0] + 10, A[1] + 2.9], { anchor: A, modifiers: shift }), P); // ~16° → 15° step
    assert.equal(l.kind, 'line');
    if (l.kind === 'line') assert.ok(Math.abs(Math.atan2(l.dir[1], l.dir[0]) * (180 / Math.PI) - 15) < 1e-12);
  });

  it('a non-finite or non-positive angle step falls back to ortho', () => {
    const shift = { shift: true, alt: false };
    for (const angleStepDeg of [Infinity, NaN, 0, -15, Number.MIN_VALUE]) {
      const l = buildLocus(query([6, 4], { anchor: A, modifiers: shift }), { ...P, angleStepDeg });
      assert.deepEqual(l, { kind: 'line', origin: A, dir: [1, 0] }, `angleStepDeg ${angleStepDeg}`);
    }
  });

  it('a typed angle outranks an axis lock', () => {
    const l = buildLocus(query([9, 9], { anchor: A, locks: { angleDeg: 0, axis: 'v' } }), P);
    assert.deepEqual(l, { kind: 'ray', origin: A, dir: [1, 0] });
  });
});

describe('projectOntoLocus', () => {
  it('keeps the pinned coordinate of an axis-aligned line exact', () => {
    const l: Locus = { kind: 'line', origin: [0.1, 0.7], dir: [1, 0] };
    assert.deepEqual(projectOntoLocus([123.456789, -5], l), [123.456789, 0.7]);
  });

  it('clamps a ray at its origin', () => {
    const l: Locus = { kind: 'ray', origin: [1, 1], dir: [1, 0] };
    assert.deepEqual(projectOntoLocus([-4, 2], l), [1, 1]);
  });

  it('lands on every locus kind for random points', () => {
    const r = rng(11);
    const loci: Locus[] = [
      { kind: 'line', origin: [3, -2], dir: [0.6, 0.8] },
      { kind: 'ray', origin: [-1, 4], dir: [-2, 1] },
      { kind: 'circle', center: [5, 5], radius: 2.25 },
    ];
    for (let i = 0; i < 500; i++) {
      const p: Vec2 = [r() * 200 - 100, r() * 200 - 100];
      for (const l of loci) {
        // Independent oracle (not distanceToLocus, which reuses projectOntoLocus):
        // the result is ON the locus and is the CLOSEST point of it to p.
        const x = projectOntoLocus(p, l);
        const eps = 1e-9 * (1 + Math.hypot(p[0], p[1]));
        if (l.kind === 'circle') {
          const v: Vec2 = [x[0] - l.center[0], x[1] - l.center[1]];
          const w: Vec2 = [p[0] - l.center[0], p[1] - l.center[1]];
          assert.ok(Math.abs(Math.hypot(v[0], v[1]) - l.radius) < eps, 'on the circle');
          assert.ok(Math.abs(v[0] * w[1] - v[1] * w[0]) < eps * 100 && v[0] * w[0] + v[1] * w[1] >= 0, 'radially towards p');
        } else if (l.kind === 'line' || l.kind === 'ray') {
          const { origin: o, dir: d } = l;
          const n = Math.hypot(d[0], d[1]);
          const v: Vec2 = [x[0] - o[0], x[1] - o[1]];
          assert.ok(Math.abs(v[0] * d[1] - v[1] * d[0]) / n < eps, 'on the line');
          const along = (p[0] - o[0]) * d[0] + (p[1] - o[1]) * d[1];
          if (l.kind === 'line' || along > 0) {
            assert.ok(Math.abs((p[0] - x[0]) * d[0] + (p[1] - x[1]) * d[1]) / n < eps, 'foot of the perpendicular');
          } else {
            assert.deepEqual(x, o, 'clamped to the ray origin');
          }
        }
      }
    }
  });
});

describe('intersectLocusWithGuide', () => {
  it('a line lock crosses a segment only inside it', () => {
    const l: Locus = { kind: 'line', origin: [0, 0], dir: [1, 0] };
    assert.deepEqual(intersectLocusWithGuide(l, { kind: 'segment', a: [2, -1], b: [4, 1], role: 'edge' }), [[3, 0]]);
    assert.deepEqual(intersectLocusWithGuide(l, { kind: 'segment', a: [2, 1], b: [4, 3], role: 'edge' }), []);
    assert.deepEqual(intersectLocusWithGuide(l, { kind: 'segment', a: [2, 1], b: [4, 1], role: 'edge' }), [], 'parallel');
  });

  it('a circle lock crosses a segment at points on the circle', () => {
    const l: Locus = { kind: 'circle', center: [0, 0], radius: 5 };
    const hits = intersectLocusWithGuide(l, { kind: 'segment', a: [-10, 3], b: [10, 3], role: 'edge' });
    assert.equal(hits.length, 2);
    for (const h of hits) {
      assert.ok(Math.abs(Math.hypot(h[0], h[1]) - 5) < 1e-12);
      assert.ok(Math.abs(Math.abs(h[0]) - 4) < 1e-12 && Math.abs(h[1] - 3) < 1e-12);
    }
  });
});
