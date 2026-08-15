/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { AABBUtils, type AABB } from './aabb.js';

function box(
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): AABB {
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

describe('AABBUtils.intersects', () => {
  it('is inclusive at an exact face touch on EVERY axis', () => {
    const unit = box(0, 0, 0, 1, 1, 1);
    // One neighbour per axis, sharing exactly one face plane. Each is asserted
    // separately so a single-axis regression cannot hide behind the others.
    expect(AABBUtils.intersects(unit, box(1, 0, 0, 2, 1, 1))).toBe(true); // +x
    expect(AABBUtils.intersects(unit, box(-1, 0, 0, 0, 1, 1))).toBe(true); // -x
    expect(AABBUtils.intersects(unit, box(0, 1, 0, 1, 2, 1))).toBe(true); // +y
    expect(AABBUtils.intersects(unit, box(0, -1, 0, 1, 0, 1))).toBe(true); // -y
    expect(AABBUtils.intersects(unit, box(0, 0, 1, 1, 1, 2))).toBe(true); // +z
    expect(AABBUtils.intersects(unit, box(0, 0, -1, 1, 1, 0))).toBe(true); // -z
  });

  it('separates on any single axis even when the other two overlap', () => {
    const unit = box(0, 0, 0, 1, 1, 1);
    // A hair past the touching plane on exactly one axis.
    expect(AABBUtils.intersects(unit, box(1.0001, 0, 0, 2, 1, 1))).toBe(false);
    expect(AABBUtils.intersects(unit, box(0, 1.0001, 0, 1, 2, 1))).toBe(false);
    expect(AABBUtils.intersects(unit, box(0, 0, 1.0001, 1, 1, 2))).toBe(false);
  });

  it('is symmetric — a∩b and b∩a agree for touching, overlapping and disjoint', () => {
    const cases: Array<[AABB, AABB]> = [
      [box(0, 0, 0, 1, 1, 1), box(1, 0, 0, 2, 1, 1)],
      [box(0, 0, 0, 1, 1, 1), box(0.5, 0.5, 0.5, 3, 3, 3)],
      [box(0, 0, 0, 1, 1, 1), box(5, 5, 5, 6, 6, 6)],
      [box(-4, -4, -4, -3, -3, -3), box(-3, -4, -4, -2, -3, -3)],
    ];
    for (const [a, b] of cases) {
      expect(AABBUtils.intersects(a, b)).toBe(AABBUtils.intersects(b, a));
    }
  });

  it('handles fully negative coordinates', () => {
    expect(AABBUtils.intersects(box(-10, -10, -10, -5, -5, -5), box(-6, -6, -6, -1, -1, -1))).toBe(true);
    expect(AABBUtils.intersects(box(-10, -10, -10, -5, -5, -5), box(-4, -4, -4, -1, -1, -1))).toBe(false);
  });

  it('treats a zero-volume (degenerate) box as intersecting when it lies on the surface', () => {
    const unit = box(0, 0, 0, 1, 1, 1);
    const plane = box(1, 0, 0, 1, 1, 1); // zero extent on x, sitting on the +x face
    expect(AABBUtils.intersects(unit, plane)).toBe(true);
    const point = box(0.5, 0.5, 0.5, 0.5, 0.5, 0.5);
    expect(AABBUtils.intersects(unit, point)).toBe(true);
  });
});

describe('AABBUtils.contains (point in box)', () => {
  it('is inclusive on both the min and the max face of every axis', () => {
    const unit = box(0, 0, 0, 1, 1, 1);
    expect(AABBUtils.contains(unit, [0, 0.5, 0.5])).toBe(true);
    expect(AABBUtils.contains(unit, [1, 0.5, 0.5])).toBe(true);
    expect(AABBUtils.contains(unit, [0.5, 0, 0.5])).toBe(true);
    expect(AABBUtils.contains(unit, [0.5, 1, 0.5])).toBe(true);
    expect(AABBUtils.contains(unit, [0.5, 0.5, 0])).toBe(true);
    expect(AABBUtils.contains(unit, [0.5, 0.5, 1])).toBe(true);
    // Corners are in.
    expect(AABBUtils.contains(unit, [0, 0, 0])).toBe(true);
    expect(AABBUtils.contains(unit, [1, 1, 1])).toBe(true);
  });

  it('rejects a point just outside on each axis', () => {
    const unit = box(0, 0, 0, 1, 1, 1);
    expect(AABBUtils.contains(unit, [-0.0001, 0.5, 0.5])).toBe(false);
    expect(AABBUtils.contains(unit, [1.0001, 0.5, 0.5])).toBe(false);
    expect(AABBUtils.contains(unit, [0.5, -0.0001, 0.5])).toBe(false);
    expect(AABBUtils.contains(unit, [0.5, 1.0001, 0.5])).toBe(false);
    expect(AABBUtils.contains(unit, [0.5, 0.5, -0.0001])).toBe(false);
    expect(AABBUtils.contains(unit, [0.5, 0.5, 1.0001])).toBe(false);
  });

  it('works with negative coordinates', () => {
    const b = box(-3, -3, -3, -1, -1, -1);
    expect(AABBUtils.contains(b, [-2, -2, -2])).toBe(true);
    expect(AABBUtils.contains(b, [0, -2, -2])).toBe(false);
  });
});

describe('AABBUtils.union / center / size / surfaceArea', () => {
  it('unions disjoint boxes into the enclosing box', () => {
    expect(AABBUtils.union(box(0, 0, 0, 1, 1, 1), box(4, -2, 3, 5, -1, 7))).toEqual(
      box(0, -2, 0, 5, 1, 7),
    );
  });

  it('union is idempotent and absorbs a contained box', () => {
    const outer = box(-1, -1, -1, 4, 4, 4);
    expect(AABBUtils.union(outer, outer)).toEqual(outer);
    expect(AABBUtils.union(outer, box(0, 0, 0, 1, 1, 1))).toEqual(outer);
  });

  it('computes the centre for asymmetric and negative boxes', () => {
    expect(AABBUtils.center(box(0, 0, 0, 2, 4, 6))).toEqual([1, 2, 3]);
    expect(AABBUtils.center(box(-4, -4, -4, -2, 0, 4))).toEqual([-3, -2, 0]);
  });

  it('computes per-axis size, distinguishing the axes', () => {
    // Deliberately unequal extents: a cube would pass even with axes swapped.
    expect(AABBUtils.size(box(0, 0, 0, 2, 5, 11))).toEqual([2, 5, 11]);
  });

  it('computes surface area of a non-cubic box', () => {
    // 2*(w*h + w*d + h*d) = 2*(2*3 + 2*4 + 3*4) = 2*26 = 52
    expect(AABBUtils.surfaceArea(box(0, 0, 0, 2, 3, 4))).toBe(52);
    // A flat (zero-thickness) box still has two faces of area w*h.
    expect(AABBUtils.surfaceArea(box(0, 0, 0, 2, 3, 0))).toBe(12);
    // A degenerate point has zero area.
    expect(AABBUtils.surfaceArea(box(1, 1, 1, 1, 1, 1))).toBe(0);
  });
});
