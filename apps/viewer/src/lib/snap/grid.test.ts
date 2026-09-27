/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nearestGridNode, UniformGridIndex } from './grid.js';
import type { Vec2 } from './types.js';
import { rng } from '@/test/snap-fixture.js';

describe('nearestGridNode (#6232 WP3)', () => {
  it('rounds to the node lattice through the grid origin', () => {
    assert.deepEqual(nearestGridNode([1.26, -0.74], { origin: [0, 0], spacing: 0.5 }), [1.5, -0.5]);
    assert.deepEqual(nearestGridNode([1.26, -0.74], { origin: [0.1, 0.1], spacing: 1 }), [1.1, -0.9]);
  });

  it('refuses a degenerate spacing', () => {
    assert.equal(nearestGridNode([1, 1], { origin: [0, 0], spacing: 0 }), null);
    assert.equal(nearestGridNode([1, 1], { origin: [0, 0], spacing: Number.NaN }), null);
  });
});

describe('UniformGridIndex', () => {
  it('returns exactly the brute-force neighbourhood (random points, negative coords, any radius)', () => {
    const r = rng(7);
    const pts: Vec2[] = [];
    const idx = new UniformGridIndex<number>(0.75);
    for (let i = 0; i < 2000; i++) {
      const p: Vec2 = [r() * 60 - 30, r() * 60 - 30];
      pts.push(p);
      idx.insert(p, i);
    }
    assert.equal(idx.size, 2000);
    for (let k = 0; k < 200; k++) {
      const c: Vec2 = [r() * 70 - 35, r() * 70 - 35];
      const radius = k % 10 === 0 ? 25 : r() * 3; // every tenth query takes the bucket-scan path (and still has points beyond it)
      const got: number[] = [];
      idx.query(c, radius, (i) => got.push(i));
      const want = pts.flatMap((p, i) => (Math.hypot(p[0] - c[0], p[1] - c[1]) <= radius ? [i] : []));
      assert.deepEqual(got.sort((a, b) => a - b), want);
    }
  });

  it('terminates for cell indices beyond 2^53 and for a non-finite centre', () => {
    const idx = new UniformGridIndex<string>(1);
    idx.insert([2 ** 53, 0], 'far');
    const got: string[] = [];
    idx.query([2 ** 53, 0], 0, (item) => got.push(item));
    assert.deepEqual(got, ['far']);
    idx.query([Infinity, 0], 1, (item) => got.push(item));
    assert.deepEqual(got, ['far']);
  });

  it('clear empties it; a bad cell size is a RangeError', () => {
    const idx = new UniformGridIndex<string>(1);
    idx.insert([0, 0], 'a');
    idx.clear();
    let n = 0;
    idx.query([0, 0], 10, () => n++);
    assert.equal(n, 0);
    assert.throws(() => new UniformGridIndex(0), RangeError);
  });
});
