// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * RED/GREEN for issue #3575: the optimized decoder must apply a per-instance
 * rotation (`rot0..rot8`) to the shared TEMPLATE-local vertices before
 * `origin` places them, so two occurrences of one dedup'd shape at different
 * orientations decode to different world geometry instead of both landing at
 * the template's own (unrotated) pose.
 */

import { describe, it, expect } from 'vitest';
import { buildMeshesFromOptimizedTables, type ArrowTableLike } from './parquet-tables.js';
import { applyInstanceRotation, readRotationColumns } from './parquet-rotation.js';

function table(columns: Record<string, ArrayLike<number> | string[]>): ArrowTableLike {
  return {
    getChild(name: string) {
      const col = columns[name];
      if (col === undefined) return null;
      return {
        toArray: () => col as ArrayLike<number>,
        get: (i: number) => (col as ArrayLike<unknown>)[i],
      };
    },
  };
}

// Row-major 3x3 that CYCLES axes: (x, y, z) -> (z, x, y). A proper rotation
// (det = 1), chosen so a hand-computed expectation is trivial to check.
const CYCLE_XYZ = [0, 0, 1, 1, 0, 0, 0, 1, 0];
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function rotationColumns(rows: number[][]): Record<string, Float32Array> {
  const cols: Record<string, Float32Array> = {};
  for (let i = 0; i < 9; i++) {
    cols[`rot${i}`] = new Float32Array(rows.map((r) => r[i]));
  }
  return cols;
}

/** Two instances sharing one triangle template: (0,0,0),(1,0,0),(1,1,0). */
function fixture(
  extraInstanceCols: Record<string, ArrayLike<number>>,
  wireVersion: 2 | 3 = 3
) {
  return {
    instanceArrow: table({
      entity_id: new Uint32Array([10, 11]),
      ifc_type: ['IfcFurniture', 'IfcFurniture'],
      mesh_index: new Uint32Array([0, 0]),
      material_index: new Uint32Array([0, 0]),
      ...extraInstanceCols,
    }),
    meshArrow: table({
      vertex_offset: new Uint32Array([0]),
      vertex_count: new Uint32Array([3]),
      index_offset: new Uint32Array([0]),
      index_count: new Uint32Array([3]),
    }),
    materialArrow: table({
      r: new Uint8Array([255]),
      g: new Uint8Array([0]),
      b: new Uint8Array([0]),
      a: new Uint8Array([255]),
    }),
    vertexArrow: table({
      x: new Int32Array([0, 10000, 10000]),
      y: new Int32Array([0, 0, 10000]),
      z: new Int32Array([0, 0, 0]),
    }),
    indexArrow: table({ i: new Uint32Array([0, 1, 2]) }),
    hasNormals: false,
    vertexMultiplier: 10000,
    wireVersion,
  };
}

describe('buildMeshesFromOptimizedTables rotation (#3575)', () => {
  it('rotates a dedup templated instance by its OWN rot0..rot8, not the template pose', () => {
    const meshes = buildMeshesFromOptimizedTables(
      fixture(rotationColumns([IDENTITY, CYCLE_XYZ]))
    );

    // Instance 0 (identity): unchanged template.
    expect(Array.from(meshes[0].positions)).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    // Instance 1 (cycle x,y,z -> z,x,y applied to each vertex):
    // (0,0,0) -> (0,0,0); (1,0,0) -> (0,1,0); (1,1,0) -> (0,1,1).
    expect(Array.from(meshes[1].positions)).toEqual([0, 0, 0, 0, 1, 0, 0, 1, 1]);
    // The two instances still share one template mesh (dedup intact) but no
    // longer decode to the SAME world-shape vertices — that is the bug.
    expect(Array.from(meshes[0].positions)).not.toEqual(Array.from(meshes[1].positions));
  });

  it('is a no-op (identity) when rot columns are absent — pre-#3575 payloads unaffected', () => {
    // Absent rotation columns are only benign on a v2 payload, where they
    // never existed — not on v3, which guarantees them (see the next test).
    const meshes = buildMeshesFromOptimizedTables(fixture({}, 2));
    expect(Array.from(meshes[0].positions)).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    expect(Array.from(meshes[1].positions)).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0]);
  });

  it('throws on a v3 payload missing its rot0..rot8 columns instead of silently decoding identity', () => {
    // Format v3 defines rot0..rot8 as present whenever the server ran the
    // rotation-aware path (see optimized_wire_version in parquet_optimized_instancing.rs).
    // A v3 payload with the columns missing/short is truncated wire data, not
    // an older format — decoding it as identity would place a genuinely
    // rotated occurrence at the wrong orientation with no signal why.
    expect(() => buildMeshesFromOptimizedTables(fixture({}, 3))).toThrow(
      /format version 3 requires rot0\.\.rot8/
    );
  });

  it('a version-3 payload that DOES carry rot0..rot8 still decodes normally', () => {
    const meshes = buildMeshesFromOptimizedTables(
      fixture(rotationColumns([IDENTITY, CYCLE_XYZ]), 3)
    );
    expect(Array.from(meshes[0].positions)).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    expect(Array.from(meshes[1].positions)).toEqual([0, 0, 0, 0, 1, 0, 0, 1, 1]);
  });

  it('readRotationColumns rejects a short (non-parallel) column set', () => {
    const t = table({ rot0: new Float32Array([1]) });
    expect(readRotationColumns(t, 2)).toBeUndefined();
  });

  it('applyInstanceRotation rotates positions and normals together', () => {
    const positions = new Float32Array([1, 0, 0]);
    const normals = new Float32Array([1, 0, 0]);
    const cols = [CYCLE_XYZ[0], CYCLE_XYZ[1], CYCLE_XYZ[2], CYCLE_XYZ[3], CYCLE_XYZ[4], CYCLE_XYZ[5], CYCLE_XYZ[6], CYCLE_XYZ[7], CYCLE_XYZ[8]].map(
      (v) => new Float32Array([v])
    );
    applyInstanceRotation(positions, normals, cols, 0);
    expect(Array.from(positions)).toEqual([0, 1, 0]);
    expect(Array.from(normals)).toEqual([0, 1, 0]);
  });

  // A NaN rotation cell must never render as a silently-unrotated (identity)
  // placement, and must never be applied either — both leave the viewer
  // showing plausible-looking but wrong geometry with no error. Malformed
  // wire data throws, matching this function's other malformed-input checks.
  it('applyInstanceRotation throws on a NaN rotation cell instead of applying it or treating it as identity', () => {
    const positions = new Float32Array([1, 0, 0]);
    // Otherwise identity except rot4 (row-major [1,1], the y->y term) is NaN.
    const cols = [1, 0, 0, 0, NaN, 0, 0, 0, 1].map((v) => new Float32Array([v]));
    expect(() => applyInstanceRotation(positions, undefined, cols, 0)).toThrow(/non-finite/i);
    // Not applied: the buffer is untouched, not silently corrupted to NaN.
    expect(Array.from(positions)).toEqual([1, 0, 0]);
  });

  it('applyInstanceRotation throws on an Infinity rotation cell the same way', () => {
    const positions = new Float32Array([1, 0, 0]);
    const cols = [1, 0, 0, 0, 1, 0, 0, 0, Infinity].map((v) => new Float32Array([v]));
    expect(() => applyInstanceRotation(positions, undefined, cols, 0)).toThrow(/non-finite/i);
  });

  it('control: a genuine identity row is still treated as identity (no throw, no mutation)', () => {
    const positions = new Float32Array([1, 2, 3]);
    const cols = IDENTITY.map((v) => new Float32Array([v]));
    expect(() => applyInstanceRotation(positions, undefined, cols, 0)).not.toThrow();
    expect(Array.from(positions)).toEqual([1, 2, 3]);
  });

  it('control: a genuine non-identity rotation still rotates (no throw)', () => {
    const positions = new Float32Array([1, 0, 0]);
    const cols = CYCLE_XYZ.map((v) => new Float32Array([v]));
    expect(() => applyInstanceRotation(positions, undefined, cols, 0)).not.toThrow();
    expect(Array.from(positions)).toEqual([0, 1, 0]);
  });
});
