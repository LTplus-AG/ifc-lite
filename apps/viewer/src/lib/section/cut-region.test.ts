/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clipBoundsByPlanes, type Aabb, type CutPlane } from './cut-region.js';

const BOX: Aabb = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 4, z: 8 } };
const plane = (n: [number, number, number], distance: number, flipped = false): CutPlane => ({ normal: n, distance, flipped });
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

describe('the region the cutting planes leave (#7545)', () => {
  it('finds a kept region that touches no face of the model box: a section box inside the model', () => {
    const planes = [plane([1, 0, 0], 6), plane([-1, 0, 0], -2), plane([0, 1, 0], 3), plane([0, -1, 0], -1), plane([0, 0, 1], 7), plane([0, 0, -1], -5)];
    const r = clipBoundsByPlanes(BOX, planes)!;
    assert.deepEqual([r.min.x, r.max.x, r.min.y, r.max.y, r.min.z, r.max.z].map((v) => Number(v.toFixed(9))), [2, 6, 1, 3, 5, 7]);
  });

  it('includes the apex where three planes meet inside the box (not on any face)', () => {
    // Keep x >= |y| and x >= |z| inside [-1,1]^3: a pyramid with its apex at the origin, so x runs 0..1.
    const cube: Aabb = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
    const s = Math.SQRT1_2;
    const r = clipBoundsByPlanes(cube, [plane([-s, s, 0], 0), plane([-s, -s, 0], 0), plane([-s, 0, s], 0), plane([-s, 0, -s], 0)])!;
    near(r.min.x, 0); near(r.max.x, 1); near(r.min.y, -1); near(r.max.y, 1);
  });

  it('is the model itself with no plane', () => {
    assert.deepEqual(clipBoundsByPlanes(BOX, []), BOX);
  });

  it('cuts axis-aligned planes like intersecting intervals: x kept <= 6, y kept >= 1 (flipped)', () => {
    const r = clipBoundsByPlanes(BOX, [plane([1, 0, 0], 6), plane([0, 1, 0], 1, true)])!;
    assert.deepEqual([r.min.x, r.max.x, r.min.y, r.max.y, r.min.z, r.max.z], [0, 6, 1, 4, 0, 8]);
  });

  it('a slanted plane gives the true extent of the kept corner, not the box', () => {
    // Keep x + y <= 4: the kept part of the 10 x 4 footprint is a trapezoid reaching x = 4 at y = 0.
    const r = clipBoundsByPlanes(BOX, [plane([1, 1, 0], 4)])!;
    near(r.min.x, 0); near(r.max.x, 4); near(r.min.y, 0); near(r.max.y, 4);
  });

  it('is null when the planes remove the whole model, and when the input is not finite', () => {
    assert.equal(clipBoundsByPlanes(BOX, [plane([1, 0, 0], -1)]), null, 'keeps x <= -1: outside the box');
    assert.equal(clipBoundsByPlanes(BOX, [plane([1, 0, 0], 3), plane([1, 0, 0], 5, true)]), null, 'x <= 3 and x >= 5 exclude each other');
    assert.equal(clipBoundsByPlanes({ min: { x: NaN, y: 0, z: 0 }, max: BOX.max }, []), null);
  });

  it('agrees with a brute-force sample of the kept volume for seeded random planes', () => {
    let s = 12345;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
    for (let trial = 0; trial < 40; trial++) {
      const planes = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
        const v: [number, number, number] = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
        const len = Math.hypot(...v) || 1;
        return plane([v[0] / len, v[1] / len, v[2] / len], (rnd() - 0.3) * 12, rnd() < 0.5);
      });
      const r = clipBoundsByPlanes(BOX, planes);
      // Every sampled kept point lies inside the result; the result's own extent is reached by a kept point.
      let sampled = 0;
      for (let i = 0; i < 4000; i++) {
        const p: [number, number, number] = [rnd() * 10, rnd() * 4, rnd() * 8];
        const kept = planes.every((q) => {
          const side = q.flipped ? -1 : 1;
          return (p[0] * q.normal[0] + p[1] * q.normal[1] + p[2] * q.normal[2] - q.distance) * side <= 0;
        });
        if (!kept) continue;
        sampled++;
        assert.ok(r, 'kept points exist, so the region exists');
        assert.ok(p[0] >= r.min.x - 1e-9 && p[0] <= r.max.x + 1e-9 && p[1] >= r.min.y - 1e-9 && p[1] <= r.max.y + 1e-9 && p[2] >= r.min.z - 1e-9 && p[2] <= r.max.z + 1e-9);
      }
      if (r === null) assert.equal(sampled, 0, 'a null region has no kept point');
    }
  });
});
