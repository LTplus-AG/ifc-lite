/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import { describe, expect, it } from 'vitest';
import { castRay } from './raycast.js';

/** One triangle in the plane z = 5: (0,0,5) (1,0,5) (0,1,5). */
function triangleMesh(expressId: number, ifcType = 'IfcWall'): MeshData {
  return {
    expressId,
    ifcType,
    positions: new Float32Array([0, 0, 5, 1, 0, 5, 0, 1, 5]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  };
}

describe('castRay', () => {
  it('hits a triangle along +Z and reports the entity, distance and point', () => {
    const hit = castRay([triangleMesh(42)], [0.25, 0.25, 0], [0, 0, 1]);
    expect(hit).not.toBeNull();
    expect(hit?.expressId).toBe(42);
    expect(hit?.ifcType).toBe('IfcWall');
    expect(hit?.distance).toBeCloseTo(5, 6);
    expect(hit?.point[0]).toBeCloseTo(0.25, 6);
    expect(hit?.point[1]).toBeCloseTo(0.25, 6);
    expect(hit?.point[2]).toBeCloseTo(5, 6);
  });

  it('normalizes the direction so distance is in world units regardless of its length', () => {
    const hit = castRay([triangleMesh(1)], [0.25, 0.25, 0], [0, 0, 10]);
    expect(hit?.distance).toBeCloseTo(5, 6);
  });

  it('misses when the ray passes outside the triangle', () => {
    expect(castRay([triangleMesh(1)], [2, 2, 0], [0, 0, 1])).toBeNull();
  });

  it('misses triangles behind the origin', () => {
    expect(castRay([triangleMesh(1)], [0.25, 0.25, 0], [0, 0, -1])).toBeNull();
  });

  it('returns the nearest of several hits', () => {
    const near: MeshData = { ...triangleMesh(7), positions: new Float32Array([0, 0, 2, 1, 0, 2, 0, 1, 2]) };
    const far = triangleMesh(8); // z = 5
    const hit = castRay([far, near], [0.25, 0.25, 0], [0, 0, 1]);
    expect(hit?.expressId).toBe(7);
    expect(hit?.distance).toBeCloseTo(2, 6);
  });

  it('returns null for a zero-length direction', () => {
    expect(castRay([triangleMesh(1)], [0, 0, 0], [0, 0, 0])).toBeNull();
  });
});
