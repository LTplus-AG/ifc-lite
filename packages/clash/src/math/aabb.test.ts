/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Boundary contract for the box kernel behind the clash narrow phase.
 *
 * These wrappers bind the Plato-generated single-source math (generated/plato.g.ts)
 * that is ALSO transpiled to Rust (rust/clash/src/generated/plato.rs). The two
 * kernels must agree exactly at the touching point, so the `<=` / `>=` choices
 * are a cross-language contract, not an implementation detail.
 */

import { describe, expect, it } from 'vitest';
import {
  aabbContains,
  boundsOfPoints,
  center,
  fromPositions,
  inflate,
  intersects,
  overlapBounds,
  signedGap,
} from './aabb.js';
import type { AABB, Mat4, Vec3 } from '../types.js';

function box(
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): AABB {
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

const UNIT = box(0, 0, 0, 1, 1, 1);

describe('intersects', () => {
  it('counts an exact face touch as intersecting, on every axis and both signs', () => {
    expect(intersects(UNIT, box(1, 0, 0, 2, 1, 1))).toBe(true);
    expect(intersects(UNIT, box(-1, 0, 0, 0, 1, 1))).toBe(true);
    expect(intersects(UNIT, box(0, 1, 0, 1, 2, 1))).toBe(true);
    expect(intersects(UNIT, box(0, -1, 0, 1, 0, 1))).toBe(true);
    expect(intersects(UNIT, box(0, 0, 1, 1, 1, 2))).toBe(true);
    expect(intersects(UNIT, box(0, 0, -1, 1, 1, 0))).toBe(true);
  });

  it('separates on a single axis while the other two still overlap', () => {
    expect(intersects(UNIT, box(1.0001, 0, 0, 2, 1, 1))).toBe(false);
    expect(intersects(UNIT, box(0, 1.0001, 0, 1, 2, 1))).toBe(false);
    expect(intersects(UNIT, box(0, 0, 1.0001, 1, 1, 2))).toBe(false);
  });

  it('is symmetric', () => {
    const cases: Array<[AABB, AABB]> = [
      [UNIT, box(1, 0, 0, 2, 1, 1)],
      [UNIT, box(0.5, 0.5, 0.5, 4, 4, 4)],
      [UNIT, box(9, 9, 9, 10, 10, 10)],
      [box(-9, -9, -9, -8, -8, -8), box(-8, -9, -9, -7, -8, -8)],
    ];
    for (const [a, b] of cases) expect(intersects(a, b)).toBe(intersects(b, a));
  });
});

describe('aabbContains', () => {
  it('counts a shared face as contained (documented `<=` / `>=` contract)', () => {
    expect(aabbContains(UNIT, UNIT)).toBe(true);
    expect(aabbContains(UNIT, box(0, 0, 0, 0.5, 1, 1))).toBe(true); // shares min-x face
    expect(aabbContains(UNIT, box(0.5, 0, 0, 1, 1, 1))).toBe(true); // shares max-x face
  });

  it('rejects an inner box poking out on any single axis', () => {
    expect(aabbContains(UNIT, box(-0.0001, 0, 0, 1, 1, 1))).toBe(false);
    expect(aabbContains(UNIT, box(0, 0, 0, 1.0001, 1, 1))).toBe(false);
    expect(aabbContains(UNIT, box(0, -0.0001, 0, 1, 1, 1))).toBe(false);
    expect(aabbContains(UNIT, box(0, 0, 0, 1, 1.0001, 1))).toBe(false);
    expect(aabbContains(UNIT, box(0, 0, -0.0001, 1, 1, 1))).toBe(false);
    expect(aabbContains(UNIT, box(0, 0, 0, 1, 1, 1.0001))).toBe(false);
  });

  it('is NOT symmetric — argument order decides outer vs inner', () => {
    const inner = box(0.25, 0.25, 0.25, 0.75, 0.75, 0.75);
    expect(aabbContains(UNIT, inner)).toBe(true);
    expect(aabbContains(inner, UNIT)).toBe(false);
  });

  it('handles negative coordinates', () => {
    const outer = box(-10, -10, -10, -1, -1, -1);
    expect(aabbContains(outer, box(-9, -9, -9, -2, -2, -2))).toBe(true);
    expect(aabbContains(outer, box(-11, -9, -9, -2, -2, -2))).toBe(false);
  });
});

describe('signedGap', () => {
  it('is zero for boxes that exactly touch', () => {
    // `-0` (the negated zero overlap) — compare numerically, not with Object.is.
    expect(signedGap(UNIT, box(1, 0, 0, 2, 1, 1))).toBeCloseTo(0, 12);
  });

  it('is the Euclidean separation when the boxes are apart on one axis', () => {
    expect(signedGap(UNIT, box(3, 0, 0, 4, 1, 1))).toBeCloseTo(2, 12);
  });

  it('is the diagonal distance when the boxes are apart on several axes', () => {
    // Corner-to-corner: 3 on x, 4 on y -> 5.
    expect(signedGap(UNIT, box(4, 5, 0, 5, 6, 1))).toBeCloseTo(5, 12);
  });

  it('is the negative of the MINIMUM-axis overlap when the boxes penetrate', () => {
    // Overlaps 0.9 on x but only 0.1 on y — the shallow axis wins.
    expect(signedGap(UNIT, box(0.1, 0.9, 0, 2, 2, 1))).toBeCloseTo(-0.1, 12);
  });

  it('is symmetric', () => {
    const b = box(0.1, 0.9, 0, 2, 2, 1);
    expect(signedGap(UNIT, b)).toBeCloseTo(signedGap(b, UNIT), 12);
    const far = box(4, 5, 0, 5, 6, 1);
    expect(signedGap(UNIT, far)).toBeCloseTo(signedGap(far, UNIT), 12);
  });
});

describe('overlapBounds', () => {
  it('returns the intersection box for overlapping boxes', () => {
    expect(overlapBounds(UNIT, box(0.5, 0.25, -1, 3, 0.75, 2))).toEqual(
      box(0.5, 0.25, 0, 1, 0.75, 1),
    );
  });

  it('degenerates a touching axis to the shared plane, not an inverted box', () => {
    const r = overlapBounds(UNIT, box(1, 0, 0, 2, 1, 1));
    expect(r.min[0]).toBe(1);
    expect(r.max[0]).toBe(1);
  });

  it('never produces an inverted (min > max) box for disjoint inputs', () => {
    const r = overlapBounds(UNIT, box(5, 5, 5, 6, 6, 6));
    for (let i = 0; i < 3; i += 1) expect(r.min[i]).toBeLessThanOrEqual(r.max[i]);
  });
});

describe('inflate / center / boundsOfPoints', () => {
  it('grows the box by the margin on every side', () => {
    expect(inflate(UNIT, 0.5)).toEqual(box(-0.5, -0.5, -0.5, 1.5, 1.5, 1.5));
  });

  it('shrinks on a negative margin', () => {
    expect(inflate(UNIT, -0.25)).toEqual(box(0.25, 0.25, 0.25, 0.75, 0.75, 0.75));
  });

  it('computes the centre of an asymmetric, partly negative box', () => {
    expect(center(box(-4, 0, 2, -2, 4, 8))).toEqual([-3, 2, 5]);
  });

  it('encloses two points regardless of their order', () => {
    const a: Vec3 = [3, -1, 7];
    const b: Vec3 = [-2, 5, 0];
    expect(boundsOfPoints(a, b)).toEqual(box(-2, -1, 0, 3, 5, 7));
    expect(boundsOfPoints(b, a)).toEqual(boundsOfPoints(a, b));
  });
});

describe('fromPositions', () => {
  it('bounds a packed position buffer', () => {
    const p = new Float32Array([0, 0, 0, 2, -1, 5, -3, 4, 1]);
    expect(fromPositions(p)).toEqual(box(-3, -1, 0, 2, 4, 5));
  });

  it('returns a degenerate origin box for an empty buffer, not ±Infinity', () => {
    expect(fromPositions(new Float32Array(0))).toEqual(box(0, 0, 0, 0, 0, 0));
    // A buffer too short for a single vertex is treated the same way.
    expect(fromPositions(new Float32Array([1, 2]))).toEqual(box(0, 0, 0, 0, 0, 0));
  });

  it('ignores a trailing partial vertex instead of poisoning the box with NaN', () => {
    const p = new Float32Array([0, 0, 0, 1, 1, 1, 9, 9]); // 8 floats: last vertex is short
    const r = fromPositions(p);
    expect(r).toEqual(box(0, 0, 0, 1, 1, 1));
    expect(r.min.every(Number.isFinite)).toBe(true);
    expect(r.max.every(Number.isFinite)).toBe(true);
  });

  it('drops non-finite coordinates instead of propagating ±Infinity into the bounds', () => {
    // NaN was already dropped as a side effect of `<`/`>` failing both ways.
    // ±Infinity was not: it propagated into the bounds, and two elements each
    // carrying -Infinity on the same axis then produced a NaN `boxDistance`.
    const p = new Float32Array([0, 0, 0, 1, 1, 1, -Infinity, 2, Infinity]);
    const r = fromPositions(p);
    // The finite coordinate of the poisoned vertex still counts (y = 2), the
    // non-finite ones do not — the same per-coordinate rule NaN already got.
    expect(r).toEqual(box(0, 0, 0, 1, 2, 1));
    expect(r.min.every(Number.isFinite)).toBe(true);
    expect(r.max.every(Number.isFinite)).toBe(true);
  });

  it('drops a coordinate the transform sends to ±Infinity', () => {
    // Overflow happens after the transform, so the guard has to run after it.
    const t: Mat4 = [1e300, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const p = new Float32Array([0, 0, 0, 1e30, 5, 0]);
    const r = fromPositions(p, t);
    expect(r).toEqual(box(0, 0, 0, 0, 5, 0));
  });

  it('applies a column-major transform to every vertex', () => {
    // Translate by (10, 20, 30).
    const t: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];
    const p = new Float32Array([0, 0, 0, 1, 2, 3]);
    expect(fromPositions(p, t)).toEqual(box(10, 20, 30, 11, 22, 33));
  });

  it('reads the transform column-major — a rotation is not confused with its transpose', () => {
    // 90° about +z, column-major: maps (1,0,0) -> (0,1,0). The transpose would
    // map it to (0,-1,0), so this fixture cannot pass under both conventions.
    const t: Mat4 = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const p = new Float32Array([0, 0, 0, 1, 0, 0]);
    const r = fromPositions(p, t);
    expect(r.min[1]).toBeCloseTo(0, 6);
    expect(r.max[1]).toBeCloseTo(1, 6);
    expect(r.max[0]).toBeCloseTo(0, 6);
  });
});
