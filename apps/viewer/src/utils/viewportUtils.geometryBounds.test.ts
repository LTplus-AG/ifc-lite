/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `calculateGeometryBounds` and `accumulateBoundsExcludingTypes` had no
 * direct tests anywhere in the repo (only reached indirectly through
 * `Viewport.tsx`), despite carrying real branch logic:
 *
 *  - `calculateGeometryBounds`'s degenerate-fallback comment explicitly
 *    says "Planar/linear geometry (only 1-2 axes equal) is valid and
 *    should NOT fall back" to the placeholder box — i.e. the AND across
 *    all three axes in `isFullyDegenerate` is load-bearing, not
 *    incidental.
 *  - `accumulateBoundsExcludingTypes` must exclude a mesh by `ifcType`
 *    membership in `excludeTypes`, not the opposite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { calculateGeometryBounds, accumulateBoundsExcludingTypes } from './viewportUtils.js';

/** A one-triangle mesh spanning the given per-axis coordinates. */
function mesh(
  x0: number,
  y0: number,
  z0: number,
  opts: { ifcType?: string; origin?: [number, number, number] } = {},
): MeshData {
  return {
    expressId: 1,
    ifcType: opts.ifcType,
    origin: opts.origin,
    positions: new Float32Array([x0, y0, z0, x0 + 1, y0, z0, x0, y0 + 1, z0]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
  } as unknown as MeshData;
}

describe('calculateGeometryBounds', () => {
  it('returns the placeholder box for an empty mesh list', () => {
    const b = calculateGeometryBounds([]);
    assert.deepEqual(b, { min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } });
  });

  it('returns real bounds for ordinary 3D geometry', () => {
    const b = calculateGeometryBounds([mesh(0, 0, 0)]);
    assert.deepEqual(b.min, { x: 0, y: 0, z: 0 });
    assert.deepEqual(b.max, { x: 1, y: 1, z: 0 });
  });

  it('does NOT fall back to the placeholder for planar geometry (one axis degenerate)', () => {
    // z is constant (planar in the XY plane) but x and y vary: this is
    // legitimate flat geometry, not a degenerate single point.
    const b = calculateGeometryBounds([mesh(0, 0, 5)]);
    assert.deepEqual(b.min, { x: 0, y: 0, z: 5 });
    assert.deepEqual(b.max, { x: 1, y: 1, z: 5 });
    assert.notEqual(b.max.x, 100, 'planar geometry must not fall back to the placeholder box');
  });

  it('falls back to the placeholder only when all three axes are degenerate (single point)', () => {
    const singlePoint: MeshData = {
      expressId: 1,
      positions: new Float32Array([3, 3, 3]),
      normals: new Float32Array(3),
      indices: new Uint32Array([0]),
    } as unknown as MeshData;
    const b = calculateGeometryBounds([singlePoint]);
    assert.deepEqual(b, { min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } });
  });

  it('applies the per-mesh origin so bounds are in world space', () => {
    const b = calculateGeometryBounds([mesh(0, 0, 0, { origin: [1000, 2000, 3000] })]);
    assert.deepEqual(b.min, { x: 1000, y: 2000, z: 3000 });
  });
});

describe('accumulateBoundsExcludingTypes', () => {
  it('excludes meshes whose ifcType is in the exclude set', () => {
    const meshes = [mesh(0, 0, 0, { ifcType: 'IfcSpace' }), mesh(10, 10, 10, { ifcType: 'IfcWall' })];
    const b = accumulateBoundsExcludingTypes(meshes, new Set(['IfcSpace']));
    assert.ok(b);
    assert.deepEqual(b!.min, { x: 10, y: 10, z: 10 });
  });

  it('includes meshes with no ifcType at all', () => {
    const meshes = [mesh(0, 0, 0)];
    const b = accumulateBoundsExcludingTypes(meshes, new Set(['IfcSpace']));
    assert.ok(b);
    assert.deepEqual(b!.min, { x: 0, y: 0, z: 0 });
  });

  it('returns null when every mesh is excluded', () => {
    const meshes = [mesh(0, 0, 0, { ifcType: 'IfcSpace' })];
    const b = accumulateBoundsExcludingTypes(meshes, new Set(['IfcSpace']));
    assert.equal(b, null);
  });
});
