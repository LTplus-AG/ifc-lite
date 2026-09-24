/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The cross-batch stream reader's store (issue #5407), without parquet-wasm:
 * tables are plain column objects, so these pin what the store accepts and
 * what a later batch's mesh rows can reach. The same path over REAL server
 * bytes is `parquet-stream-shapes.decode.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { StreamShapeStore } from './parquet-stream-shapes.js';
import { buildMeshesFromTables, type ArrowTableLike } from './parquet-tables.js';

function table(cols: Record<string, number[]>): ArrowTableLike {
  return {
    getChild(name) {
      const col = cols[name];
      return col ? { toArray: () => col, get: (i) => col[i] } : null;
    },
  };
}

/** One triangle's vertex table, offset by `dx` along X. */
const triangle = (dx: number) =>
  table({ x: [dx, dx + 1, dx], y: [0, 0, 1], z: [0, 0, 0], nx: [0, 0, 0], ny: [0, 0, 0], nz: [1, 1, 1] });
const oneTriangleIndex = () => table({ i0: [0], i1: [1], i2: [2] });
const emptyVertices = () => table({ x: [], y: [], z: [], nx: [], ny: [], nz: [] });
const emptyIndex = () => table({ i0: [], i1: [], i2: [] });

/** A mesh table of rows pointing at whole-stream ranges. */
function meshRows(rows: { id: number; vertexStart: number; indexStart: number; originX: number }[]) {
  return table({
    express_id: rows.map((r) => r.id),
    vertex_start: rows.map((r) => r.vertexStart),
    vertex_count: rows.map(() => 3),
    index_start: rows.map((r) => r.indexStart),
    index_count: rows.map(() => 3),
    color_r: rows.map(() => 1),
    color_g: rows.map(() => 1),
    color_b: rows.map(() => 1),
    color_a: rows.map(() => 1),
    origin_x: rows.map((r) => r.originX),
    origin_y: rows.map(() => 0),
    origin_z: rows.map(() => 0),
  });
}

describe('StreamShapeStore', () => {
  it('lets a later batch draw a shape an earlier batch carried', () => {
    const store = new StreamShapeStore();
    store.append(triangle(0), oneTriangleIndex(), 0, 0);
    store.append(triangle(10), oneTriangleIndex(), 3, 3);
    // Batch 3 sends nothing new: both rows point back, one per earlier shape.
    store.append(emptyVertices(), emptyIndex(), 6, 6);

    const meshes = buildMeshesFromTables(
      meshRows([
        { id: 7, vertexStart: 0, indexStart: 0, originX: 100 },
        { id: 8, vertexStart: 3, indexStart: 3, originX: 200 },
      ]),
      store.vertexTable(),
      store.indexTable()
    );
    expect(Array.from(meshes[0].positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(meshes[1].positions)).toEqual([10, 0, 0, 11, 0, 0, 10, 1, 0]);
    expect(meshes.map((m) => m.origin?.[0])).toEqual([100, 200]);
    // Indices are local to each mesh's own vertex block, as on every stream.
    expect(Array.from(meshes[1].indices)).toEqual([0, 1, 2]);
  });

  it('refuses a batch whose base is not what it holds, appending nothing', () => {
    const store = new StreamShapeStore();
    store.append(triangle(0), oneTriangleIndex(), 0, 0);
    // A dropped batch: this one thinks 6 vertices came before it.
    expect(() => store.append(triangle(10), oneTriangleIndex(), 6, 6)).toThrow(/missing or out of order/);
    expect(() => store.append(triangle(10), oneTriangleIndex(), 3, 0)).toThrow(/missing or out of order/);
    // Nothing was appended by the refusals, so the right base still fits.
    store.append(triangle(10), oneTriangleIndex(), 3, 3);
    expect(store.vertexTable().getChild('x')?.toArray()).toHaveLength(6);
  });

  it('refuses a ragged vertex table rather than misaligning every later row', () => {
    const store = new StreamShapeStore();
    const ragged = table({ x: [0, 1, 0], y: [0, 0], z: [0, 0, 0], nx: [0, 0, 0], ny: [0, 0, 0], nz: [1, 1, 1] });
    expect(() => store.append(ragged, oneTriangleIndex(), 0, 0)).toThrow(/ragged/);
    expect(store.vertexTable().getChild('x')?.toArray()).toHaveLength(0);
  });

  it('grows past its initial capacity without losing earlier rows', () => {
    const store = new StreamShapeStore();
    for (let batch = 0; batch < 700; batch++) {
      store.append(triangle(batch), oneTriangleIndex(), 3 * batch, 3 * batch);
    }
    const x = store.vertexTable().getChild('x')?.toArray();
    expect(x).toHaveLength(2100);
    expect(x?.[0]).toBe(0);
    expect(x?.[3 * 699 + 1]).toBe(700);
  });
});
