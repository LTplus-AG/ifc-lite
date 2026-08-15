/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { meshSurfaceArea, collectMeshAreas } from './mesh-area.js';

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

  // Adversarial review of 85ebf7d1, defect 2: an out-of-range index must not
  // poison the whole mesh to NaN. `positions` has 3 vertices (indices 0-2);
  // index 5 is out of range.
  it('does not return NaN for an out-of-range vertex index', () => {
    const mesh = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 5],
    };
    const area = meshSurfaceArea(mesh);
    assert.ok(Number.isFinite(area), `expected a finite area, got ${area}`);
  });

  it('sums the valid triangles of a mesh and skips only the corrupt one', () => {
    // Triangle 0 (0,1,2) is valid, area 0.5. Triangle 1 references index 5,
    // out of range for a 3-vertex position array — must be skipped, not let
    // its NaN poison triangle 0's contribution.
    const mesh = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2, 0, 1, 5],
    };
    assert.ok(Math.abs(meshSurfaceArea(mesh) - 0.5) < 1e-9, `expected 0.5, got ${meshSurfaceArea(mesh)}`);
  });

  it('rejects a negative vertex index rather than reading out of bounds', () => {
    const mesh = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, -1],
    };
    const area = meshSurfaceArea(mesh);
    assert.ok(Number.isFinite(area), `expected a finite area, got ${area}`);
  });
});

describe('collectMeshAreas', () => {
  it('sums submeshes within one occurrence', () => {
    const meshes = [
      { expressId: 1, occurrenceKey: 'occ-1', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }, // 0.5
      { expressId: 1, occurrenceKey: 'occ-1', positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2] }, // 2
    ];
    const result = collectMeshAreas([meshes]);
    assert.ok(Math.abs((result.get(1)?.area ?? NaN) - 2.5) < 1e-9);
    assert.strictEqual(result.get(1)?.incomplete, false);
  });

  it('keeps only the first group per expressId across occurrences', () => {
    const meshes = [
      { expressId: 1, occurrenceKey: 'occ-1', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }, // 0.5
      { expressId: 1, occurrenceKey: 'occ-2', positions: [0, 0, 0, 3, 0, 0, 0, 4, 0], indices: [0, 1, 2] }, // 6
    ];
    const result = collectMeshAreas([meshes]);
    assert.ok(Math.abs((result.get(1)?.area ?? NaN) - 0.5) < 1e-9);
  });

  // Adversarial review of 85ebf7d1, defect 2: a corrupt submesh must not
  // zero out its siblings' contribution to the same occurrence's total.
  it('does not let one corrupt submesh destroy its siblings\' contribution', () => {
    const meshes = [
      // Good submesh, area 6 (legs 3 and 4).
      { expressId: 1, occurrenceKey: 'occ-1', positions: [0, 0, 0, 3, 0, 0, 0, 4, 0], indices: [0, 1, 2] },
      // Corrupt submesh: index 5 is out of range for a 3-vertex array.
      { expressId: 1, occurrenceKey: 'occ-1', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 5] },
    ];
    const result = collectMeshAreas([meshes]);
    const entry = result.get(1);
    assert.ok(entry !== undefined, 'expected an entry for expressId 1');
    assert.ok(Number.isFinite(entry!.area), `expected a finite partial total, got ${entry!.area}`);
    assert.ok(Math.abs(entry!.area - 6) < 1e-9, `expected the good submesh's 6, got ${entry!.area}`);
    assert.strictEqual(entry!.incomplete, true, 'a corrupt submesh must mark the occurrence incomplete');
  });

  // CodeRabbit / the review's hypothesis: a present-but-empty mesh record
  // (indices: []) never triangulated anything and must read as "no mesh",
  // not "measured, 0 m²" — the panel's own claimed distinction.
  it('treats a present-but-empty mesh record as no mesh, not measured-zero', () => {
    const meshes = [
      { expressId: 1, occurrenceKey: 'occ-1', positions: [], indices: [] },
    ];
    const result = collectMeshAreas([meshes]);
    assert.strictEqual(result.has(1), false, 'an empty mesh record must not create a group');
  });

  it('still reports a genuine zero-area triangulated mesh as measured', () => {
    // Three collinear points: a real triangle that triangulated to zero area.
    const meshes = [
      { expressId: 1, occurrenceKey: 'occ-1', positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], indices: [0, 1, 2] },
    ];
    const result = collectMeshAreas([meshes]);
    assert.strictEqual(result.has(1), true);
    assert.ok(Math.abs((result.get(1)?.area ?? NaN) - 0) < 1e-9);
  });

  it('skips a mesh record with no render geometry', () => {
    const meshes = [{ expressId: 1 }];
    const result = collectMeshAreas([meshes]);
    assert.strictEqual(result.has(1), false);
  });
});
