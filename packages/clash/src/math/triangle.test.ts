/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../types.js';
import { triTriIntersect } from './triangle-intersect.js';
import { triTriDistance } from './triangle-distance.js';

const A0: Vec3 = [0, 0, 0];
const A1: Vec3 = [1, 0, 0];
const A2: Vec3 = [0, 1, 0];

describe('triTriIntersect', () => {
  it('detects a triangle piercing another', () => {
    // Vertical triangle crossing the z=0 plane within triangle A.
    const b0: Vec3 = [0.25, 0.25, -0.5];
    const b1: Vec3 = [0.25, 0.25, 0.5];
    const b2: Vec3 = [0.75, 0.25, 0];
    expect(triTriIntersect(A0, A1, A2, b0, b1, b2)).toBe(true);
  });

  it('reports no intersection for separated triangles', () => {
    const b0: Vec3 = [10, 10, 0];
    const b1: Vec3 = [11, 10, 0];
    const b2: Vec3 = [10, 11, 0];
    expect(triTriIntersect(A0, A1, A2, b0, b1, b2)).toBe(false);
  });

  it('treats bare face contact as non-intersecting (touch)', () => {
    // Coincident copy of A — interiors do not overlap in the SAT sense.
    expect(triTriIntersect(A0, A1, A2, A0, A1, A2)).toBe(false);
  });
});

describe('triTriDistance', () => {
  it('measures the gap between parallel triangles', () => {
    const b0: Vec3 = [0, 0, 0.5];
    const b1: Vec3 = [1, 0, 0.5];
    const b2: Vec3 = [0, 1, 0.5];
    const { dist } = triTriDistance(A0, A1, A2, b0, b1, b2);
    expect(dist).toBeCloseTo(0.5, 6);
  });

  it('is zero for touching triangles', () => {
    const { dist } = triTriDistance(A0, A1, A2, A0, A1, A2);
    expect(dist).toBeCloseTo(0, 6);
  });

  it('measures a clean edge-to-edge gap', () => {
    // Triangle shifted +2 in x: nearest edges are 1.0 apart (A max x = 1).
    const b0: Vec3 = [3, 0, 0];
    const b1: Vec3 = [4, 0, 0];
    const b2: Vec3 = [3, 1, 0];
    const { dist } = triTriDistance(A0, A1, A2, b0, b1, b2);
    expect(dist).toBeCloseTo(2, 6);
  });
});
