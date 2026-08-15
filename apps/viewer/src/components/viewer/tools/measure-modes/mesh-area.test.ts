/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { meshSurfaceArea } from './mesh-area.js';

describe('meshSurfaceArea', () => {
  it('sums a single right triangle to its known area', () => {
    // (0,0,0), (3,0,0), (0,4,0) — legs 3 and 4, area = 6.
    const mesh = {
      positions: [0, 0, 0, 3, 0, 0, 0, 4, 0],
      indices: [0, 1, 2],
    };
    assert.ok(Math.abs(meshSurfaceArea(mesh) - 6) < 1e-9);
  });

  it('sums a unit cube (6 faces, 2 triangles each) to surface area 6', () => {
    const p = [
      [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], // z=0
      [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1], // z=1
    ];
    const positions = p.flat();
    // 12 triangles covering all 6 faces of the unit cube.
    const indices = [
      0, 1, 2, 0, 2, 3, // bottom
      4, 6, 5, 4, 7, 6, // top
      0, 4, 5, 0, 5, 1, // front
      1, 5, 6, 1, 6, 2, // right
      2, 6, 7, 2, 7, 3, // back
      3, 7, 4, 3, 4, 0, // left
    ];
    const area = meshSurfaceArea({ positions, indices });
    assert.ok(Math.abs(area - 6) < 1e-9, `expected 6, got ${area}`);
  });

  it('is unaffected by winding order (mesh is double-sided)', () => {
    const mesh = {
      positions: [0, 0, 0, 3, 0, 0, 0, 4, 0],
      indices: [0, 2, 1], // reversed winding
    };
    assert.ok(Math.abs(meshSurfaceArea(mesh) - 6) < 1e-9);
  });

  it('is zero for an empty mesh', () => {
    assert.strictEqual(meshSurfaceArea({ positions: [], indices: [] }), 0);
  });

  it('is zero, not a crash, for a mesh record with no render geometry', () => {
    // A metadata-only mesh entry (or a test double built for a different
    // field, e.g. `{ expressId, geometryVolume }`) has nothing to sum.
    assert.strictEqual(meshSurfaceArea({}), 0);
    assert.strictEqual(meshSurfaceArea({ positions: [1, 2, 3] }), 0);
  });

  it('sums two disjoint triangles across index groups', () => {
    const mesh = {
      positions: [
        0, 0, 0, 1, 0, 0, 0, 1, 0, // area 0.5
        10, 0, 0, 12, 0, 0, 10, 2, 0, // area 2
      ],
      indices: [0, 1, 2, 3, 4, 5],
    };
    assert.ok(Math.abs(meshSurfaceArea(mesh) - 2.5) < 1e-9);
  });
});
