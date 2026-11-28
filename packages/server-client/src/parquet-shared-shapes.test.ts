// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared-shape decode: rows naming one block stay ONE shape with occurrences,
 * and every occurrence still lands exactly where the flat decode puts it.
 */

import { describe, it, expect } from 'vitest';
import { buildMeshesFromTables, type ArrowTableLike } from './parquet-tables.js';
import { buildSharedShapesFromTables, SharedShapeTracker, type SharedShapeOccurrence } from './parquet-shared-shapes.js';
import type { MeshData } from './types.js';

function table(columns: Record<string, ArrayLike<number> | string[]>): ArrowTableLike {
  return {
    getChild(name: string) {
      const col = columns[name];
      if (col === undefined) return null;
      return { toArray: () => col as ArrayLike<number>, get: (i: number) => (col as ArrayLike<unknown>)[i] };
    },
  };
}

// Two blocks: a triangle (vertices 0-2, indices 0-2) and a second triangle (vertices 3-5, indices 3-5).
const vertexTable = table({
  x: new Float32Array([0, 1, 1, 5, 6, 6]),
  y: new Float32Array([0, 0, 1, 0, 0, 2]),
  z: new Float32Array([0, 0, 0, 1, 1, 1]),
  nx: new Float32Array([0, 0, 0, 0, 0, 0]),
  ny: new Float32Array([1, 1, 1, 0, 0, 0]),
  nz: new Float32Array([0, 0, 0, 1, 1, 1]),
});
const indexTable = table({ i0: new Uint32Array([0, 0]), i1: new Uint32Array([1, 1]), i2: new Uint32Array([2, 2]) });

const YAW_90 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

interface Row { id: number; block: 0 | 1; origin?: [number, number, number]; rot?: number[]; materialId?: number; geometryClass?: number; itemId?: number }

function meshTable(rows: Row[], withRotation = true) {
  const n = rows.length;
  const col = (f: (r: Row) => number, T: Float32ArrayConstructor | Uint32ArrayConstructor | Float64ArrayConstructor = Float64Array) => new T(rows.map(f));
  const cols: Record<string, ArrayLike<number> | string[]> = {
    express_id: col((r) => r.id, Uint32Array),
    ifc_type: rows.map(() => 'IfcColumn'),
    vertex_start: col((r) => r.block * 3, Uint32Array),
    vertex_count: new Uint32Array(n).fill(3),
    index_start: col((r) => r.block * 3, Uint32Array),
    index_count: new Uint32Array(n).fill(3),
    color_r: col((r) => r.id / 100, Float32Array),
    color_g: new Float32Array(n).fill(0.5),
    color_b: new Float32Array(n).fill(0.5),
    color_a: new Float32Array(n).fill(1),
    origin_x: col((r) => r.origin?.[0] ?? 0),
    origin_y: col((r) => r.origin?.[1] ?? 0),
    origin_z: col((r) => r.origin?.[2] ?? 0),
    geometry_class: col((r) => r.geometryClass ?? 0, Uint32Array),
    geometry_item_id: col((r) => r.itemId ?? 0, Uint32Array),
    material_id: col((r) => r.materialId ?? 0, Uint32Array),
  };
  if (withRotation) for (let k = 0; k < 9; k++) cols[`rot${k}`] = col((r) => (r.rot ?? IDENT)[k], Float32Array);
  return table(cols);
}

/** World positions of a flat mesh. */
function worldOfMesh(m: MeshData): number[] {
  const o = m.origin ?? [0, 0, 0];
  return Array.from(m.positions, (v, i) => v + o[i % 3]);
}

/** World positions of one occurrence of a shape, `origin + R * p`. */
function worldOfOccurrence(positions: Float32Array, occ: SharedShapeOccurrence): number[] {
  const r = occ.rotation ?? IDENT;
  const out: number[] = [];
  for (let v = 0; v < positions.length; v += 3) {
    const [x, y, z] = [positions[v], positions[v + 1], positions[v + 2]];
    out.push(occ.origin[0] + r[0] * x + r[1] * y + r[2] * z, occ.origin[1] + r[3] * x + r[4] * y + r[5] * z, occ.origin[2] + r[6] * x + r[7] * y + r[8] * z);
  }
  return out;
}

describe('buildSharedShapesFromTables', () => {
  const rows: Row[] = [
    { id: 1, block: 0, origin: [10, 0, 0] },
    { id: 2, block: 0, origin: [20, 0, 5], rot: YAW_90, itemId: 77 },
    { id: 3, block: 1, origin: [0, 3, 0] }, // its block is named once: stays flat
    { id: 4, block: 0, materialId: 900 }, // a material-layer slice: no instance field for it, stays flat
    { id: 5, block: 0, geometryClass: 2 }, // a type template: stays flat
    { id: 6, block: 0, origin: [30, 0, 0] },
  ];

  it('keeps a block several rows name as one shape, the rest flat, and places every occurrence as the flat decode does', () => {
    const flat = buildMeshesFromTables(meshTable(rows), vertexTable, indexTable);
    const { meshes, shapes } = buildSharedShapesFromTables(meshTable(rows), vertexTable, indexTable);

    expect(meshes.map((m) => m.express_id)).toEqual([3, 4, 5]);
    expect(meshes).toEqual(flat.filter((m) => [3, 4, 5].includes(m.express_id)));
    expect(shapes).toHaveLength(1);
    const [shape] = shapes;
    expect(Array.from(shape.positions)).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    expect(shape.occurrences.map((o) => o.express_id)).toEqual([1, 2, 6]);
    expect(shape.occurrences[0].rotation).toBeUndefined();
    expect(shape.occurrences[1].rotation).toEqual(YAW_90);
    expect(shape.occurrences[1].geometry_item_id).toBe(77);
    expect(shape.occurrences[0].color).toEqual(flat[0].color);

    // Rendering parity: each occurrence's world vertices equal its flat mesh's, and the
    // triangle and mesh counts add up to the flat decode's.
    for (const occ of shape.occurrences) {
      const mesh = flat.find((m) => m.express_id === occ.express_id)!;
      expect(worldOfOccurrence(shape.positions, occ)).toEqual(worldOfMesh(mesh));
      expect(Array.from(shape.indices)).toEqual(Array.from(mesh.indices));
    }
    const triangles = (ms: MeshData[]) => ms.reduce((n, m) => n + m.indices.length / 3, 0);
    const shapeTriangles = shapes.reduce((n, s) => n + (s.indices.length / 3) * s.occurrences.length, 0);
    expect(triangles(meshes) + shapeTriangles).toBe(triangles(flat));
    expect(meshes.length + shape.occurrences.length).toBe(flat.length);
  });

  it('decodes a payload with no shared block (a -parquet-v5 cache) to exactly the flat meshes', () => {
    const v5 = [{ id: 1, block: 0 }, { id: 2, block: 1, origin: [1, 2, 3] }] as Row[];
    const { meshes, shapes } = buildSharedShapesFromTables(meshTable(v5, false), vertexTable, indexTable);
    expect(shapes).toEqual([]);
    expect(meshes).toEqual(buildMeshesFromTables(meshTable(v5, false), vertexTable, indexTable));
  });

  it('with a tracker, makes a later lone row naming an earlier batch\'s block an occurrence', () => {
    const tracker = new SharedShapeTracker();
    const first = buildSharedShapesFromTables(meshTable([{ id: 1, block: 0 }]), vertexTable, indexTable, tracker);
    expect(first.shapes).toEqual([]);
    expect(first.meshes.map((m) => m.express_id)).toEqual([1]);
    const second = buildSharedShapesFromTables(meshTable([{ id: 2, block: 0, origin: [4, 0, 0] }]), vertexTable, indexTable, tracker);
    expect(second.meshes).toEqual([]);
    expect(second.shapes.map((s) => [s.vertex_start, s.stream_wide, s.occurrences.map((o) => o.express_id)])).toEqual([[0, true, [2]]]);
    // Without the tracker the same batch stays flat.
    expect(buildSharedShapesFromTables(meshTable([{ id: 2, block: 0 }]), vertexTable, indexTable).shapes).toEqual([]);
  });

  it('refuses a non-finite rotation on a shared row, as the flat decode does', () => {
    const bad = [{ id: 1, block: 0 }, { id: 2, block: 0, rot: [NaN, 0, 0, 0, 1, 0, 0, 0, 1] }] as Row[];
    expect(() => buildSharedShapesFromTables(meshTable(bad), vertexTable, indexTable)).toThrow(/non-finite rotation/);
  });
});
