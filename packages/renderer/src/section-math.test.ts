/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  projectBoundsOntoNormal,
  planeDistanceForPosition,
  positionFromPoint,
} from './section-math.js';

const UNIT_CUBE = {
  min: { x: 0, y: 0, z: 0 },
  max: { x: 10, y: 20, z: 30 },
};

describe('section-math', () => {
  describe('projectBoundsOntoNormal', () => {
    it('collapses to the cardinal axis range for cardinal normals', () => {
      assert.deepStrictEqual(projectBoundsOntoNormal(UNIT_CUBE, [1, 0, 0]), { min: 0, max: 10, range: 10 });
      assert.deepStrictEqual(projectBoundsOntoNormal(UNIT_CUBE, [0, 1, 0]), { min: 0, max: 20, range: 20 });
      assert.deepStrictEqual(projectBoundsOntoNormal(UNIT_CUBE, [0, 0, 1]), { min: 0, max: 30, range: 30 });
    });

    it('returns a larger range for a tilted normal (diagonal of the box)', () => {
      // Diagonal [1,1,1]/sqrt(3) projects the cube diagonal (10+20+30)/sqrt(3) ≈ 34.64.
      const n: [number, number, number] = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
      const { range } = projectBoundsOntoNormal(UNIT_CUBE, n);
      assert.ok(Math.abs(range - 60 / Math.sqrt(3)) < 1e-9, `expected ${60 / Math.sqrt(3)}, got ${range}`);
    });

    it('handles negative normals (min/max swap signs)', () => {
      const { min, max, range } = projectBoundsOntoNormal(UNIT_CUBE, [-1, 0, 0]);
      assert.strictEqual(min, -10);
      assert.strictEqual(max, 0);
      assert.strictEqual(range, 10);
    });
  });

  describe('planeDistanceForPosition', () => {
    it('maps 0 → min and 100 → max along the cardinal axis', () => {
      assert.strictEqual(planeDistanceForPosition(UNIT_CUBE, [0, 1, 0], 0), 0);
      assert.strictEqual(planeDistanceForPosition(UNIT_CUBE, [0, 1, 0], 100), 20);
      assert.strictEqual(planeDistanceForPosition(UNIT_CUBE, [0, 1, 0], 50), 10);
    });

    it('clamps out-of-range positions to [0, 100]', () => {
      assert.strictEqual(planeDistanceForPosition(UNIT_CUBE, [0, 1, 0], -50), 0);
      assert.strictEqual(planeDistanceForPosition(UNIT_CUBE, [0, 1, 0], 150), 20);
    });

    it('falls back to min for degenerate bounds', () => {
      const degenerate = { min: { x: 5, y: 5, z: 5 }, max: { x: 5, y: 5, z: 5 } };
      assert.strictEqual(planeDistanceForPosition(degenerate, [0, 1, 0], 50), 5);
    });
  });

  describe('positionFromPoint', () => {
    it('is the inverse of planeDistanceForPosition on the cardinal axis', () => {
      // dist at 37% along Y should map back to 37%.
      const d = planeDistanceForPosition(UNIT_CUBE, [0, 1, 0], 37);
      const p = positionFromPoint(UNIT_CUBE, [0, 1, 0], [0, d, 0]);
      assert.ok(Math.abs(p - 37) < 1e-9, `round-trip failed: ${p}`);
    });

    it('maps the AABB corners to the expected ends', () => {
      // Point at min corner → 0%; point at max corner → 100%.
      assert.strictEqual(positionFromPoint(UNIT_CUBE, [0, 1, 0], [5, 0, 15]),  0);
      assert.strictEqual(positionFromPoint(UNIT_CUBE, [0, 1, 0], [5, 20, 15]), 100);
    });

    it('clamps a point outside the bounds-projection range', () => {
      assert.strictEqual(positionFromPoint(UNIT_CUBE, [0, 1, 0], [0, -100, 0]), 0);
      assert.strictEqual(positionFromPoint(UNIT_CUBE, [0, 1, 0], [0,  100, 0]), 100);
    });

    it('degenerate bounds return the canonical midpoint', () => {
      const degenerate = { min: { x: 5, y: 5, z: 5 }, max: { x: 5, y: 5, z: 5 } };
      assert.strictEqual(positionFromPoint(degenerate, [0, 1, 0], [5, 5, 5]), 50);
    });
  });
});
