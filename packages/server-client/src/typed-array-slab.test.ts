// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A decoded batch must not own one ArrayBuffer per mesh array. Each buffer adds
 * to the external memory that starts the browser's full garbage collections,
 * and each collection walks every model already loaded: a federation's later
 * slots then loaded several times slower than its first (see
 * `typed-array-slab.ts`). These pin the buffer count to the batch size, not to
 * its mesh count, so per-mesh allocation cannot come back unnoticed.
 */

import { describe, it, expect } from 'vitest';
import { buildMeshesFromTables, type ArrowTableLike } from './parquet-tables.js';
import { TypedArraySlab } from './typed-array-slab.js';

function table(columns: Record<string, ArrayLike<number> | string[]>): ArrowTableLike {
  return {
    getChild(name: string) {
      const col = columns[name];
      if (col === undefined) return null;
      return { toArray: () => col as ArrayLike<number>, get: (i: number) => (col as ArrayLike<unknown>)[i] };
    },
  };
}

/** `count` meshes, each its own triangle: mesh i's vertices are (i, 0, 0), (i, 1, 0), (i, 1, 1). */
function batch(count: number) {
  const v = count * 3;
  const x = new Float32Array(v), y = new Float32Array(v), z = new Float32Array(v);
  for (let i = 0; i < count; i++) { x.fill(i, 3 * i, 3 * i + 3); y[3 * i + 1] = 1; y[3 * i + 2] = 1; z[3 * i + 2] = 1; }
  const i0 = new Uint32Array(count), i1 = new Uint32Array(count).fill(1), i2 = new Uint32Array(count).fill(2);
  return [
    table({
      express_id: Uint32Array.from({ length: count }, (_, i) => 100 + i),
      ifc_type: Array.from({ length: count }, () => 'IfcSlab'),
      vertex_start: Uint32Array.from({ length: count }, (_, i) => 3 * i),
      vertex_count: new Uint32Array(count).fill(3),
      index_start: Uint32Array.from({ length: count }, (_, i) => 3 * i),
      index_count: new Uint32Array(count).fill(3),
      color_r: new Float32Array(count).fill(0.5), color_g: new Float32Array(count).fill(0.5),
      color_b: new Float32Array(count).fill(0.5), color_a: new Float32Array(count).fill(1),
    }),
    table({ x, y, z, nx: new Float32Array(v), ny: new Float32Array(v).fill(1), nz: new Float32Array(v) }),
    table({ i0, i1, i2 }),
  ] as const;
}

const buffersOf = (views: ArrayBufferView[]) => new Set(views.map((view) => view.buffer)).size;

describe('buildMeshesFromTables allocation', () => {
  it('gives a batch of many meshes one buffer per array kind, not one per mesh', () => {
    for (const count of [1, 10, 2000]) {
      const meshes = buildMeshesFromTables(...batch(count));
      expect(meshes).toHaveLength(count);
      expect(buffersOf(meshes.map((m) => m.positions))).toBe(1);
      expect(buffersOf(meshes.map((m) => m.normals))).toBe(1);
      expect(buffersOf(meshes.map((m) => m.indices))).toBe(1);
    }
  });

  it('keeps each mesh on its own, disjoint range with its own values', () => {
    const meshes = buildMeshesFromTables(...batch(50));
    meshes.forEach((m, i) => {
      expect(Array.from(m.positions)).toEqual([i, 0, 0, i, 1, 0, i, 1, 1]);
      expect(Array.from(m.normals)).toEqual([0, 1, 0, 0, 1, 0, 0, 1, 0]);
      expect(Array.from(m.indices)).toEqual([0, 1, 2]);
      expect(m.express_id).toBe(100 + i);
    });
    meshes[7].positions.fill(-1);
    meshes[7].indices.fill(9);
    expect(Array.from(meshes[6].positions)).toEqual([6, 0, 0, 6, 1, 0, 6, 1, 1]);
    expect(Array.from(meshes[8].indices)).toEqual([0, 1, 2]);
  });

  it('allocates exactly what the batch needs', () => {
    const meshes = buildMeshesFromTables(...batch(40));
    expect(meshes[0].positions.buffer.byteLength).toBe(40 * 9 * 4);
    expect(meshes[0].indices.buffer.byteLength).toBe(40 * 3 * 4);
  });
});

describe('TypedArraySlab', () => {
  it('opens a new slab only when the current one is full, and sizes the last one to what is left', () => {
    const slab = new TypedArraySlab((n) => new Float32Array(n), 10, 4);
    const views = [slab.take(3), slab.take(1), slab.take(3), slab.take(3)];
    expect(views.map((v) => v.length)).toEqual([3, 1, 3, 3]);
    expect(buffersOf(views)).toBe(3);
    expect(views.map((v) => v.buffer.byteLength / 4)).toEqual([4, 4, 4, 3]);
  });

  it('gives an array larger than a slab its own exact buffer', () => {
    const slab = new TypedArraySlab((n) => new Uint32Array(n), 20, 4);
    const big = slab.take(9);
    expect(big.length).toBe(9);
    expect(big.buffer.byteLength).toBe(9 * 4);
  });

  it('hands out zero-filled, non-overlapping views', () => {
    const slab = new TypedArraySlab((n) => new Uint32Array(n), 6, 6);
    const a = slab.take(2), b = slab.take(0), c = slab.take(4);
    a.fill(1); c.fill(2);
    expect(Array.from(a)).toEqual([1, 1]);
    expect(b.length).toBe(0);
    expect(Array.from(c)).toEqual([2, 2, 2, 2]);
  });
});
