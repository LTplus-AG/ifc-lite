/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { simplifyIndicesByClustering, LOD_MIN_TRIANGLES } from './lod-simplify.js';

/** Independent cell-equivalence oracle: first referenced vertex wins each
 * full string tuple, then discard triangles with repeated representatives.
 * Deliberately has no numeric packing or per-vertex memoization (#3991).
 */
function stringCellOracle(data: Float32Array, stride: number, indices: Uint32Array, cellSize: number) {
  if (indices.length < LOD_MIN_TRIANGLES * 3 || !(cellSize > 0) || !Number.isFinite(cellSize)) return null;
  const lanes = new Uint32Array(data.buffer, data.byteOffset, data.length);
  const cells = new Map<string, number>();
  const representatives: number[] = [];
  for (const vertex of indices) {
    const offset = vertex * stride;
    const entity = stride > 6 ? lanes[offset + 6] : 0;
    const key = `${Math.floor(data[offset] / cellSize)},${Math.floor(data[offset + 1] / cellSize)},${Math.floor(data[offset + 2] / cellSize)},${entity}`;
    if (!cells.has(key)) cells.set(key, vertex);
    representatives.push(cells.get(key)!);
  }
  const result: number[] = [];
  for (let i = 0; i < representatives.length; i += 3) {
    const [a, b, c] = representatives.slice(i, i + 3);
    if (a !== b && b !== c && a !== c) result.push(a, b, c);
  }
  return result.length === 0 || result.length >= indices.length * 0.75 ? null : Uint32Array.from(result);
}

type Point = readonly [number, number, number];

function fixture(triangle: readonly [Point, Point, Point], stride = 7) {
  const count = 600;
  // Nonzero byteOffset witnesses correct entity-lane reads from a subview.
  const storage = new Float32Array(count * 3 * stride + 8);
  const data = storage.subarray(4, storage.length - 4);
  const lanes = new Uint32Array(data.buffer, data.byteOffset, data.length);
  const indices = new Uint32Array(count * 3);
  for (let t = 0; t < count; t++) {
    for (let corner = 0; corner < 3; corner++) {
      const vertex = t * 3 + corner;
      // Four out of five triangles collapse, so nontrivial output qualifies.
      const point = triangle[t % 5 === 0 ? corner : 0];
      data.set(point, vertex * stride);
      if (stride > 6) lanes[vertex * stride + 6] = t % 2 === 0 ? 0xffffffff : 1;
      indices[vertex] = vertex;
    }
  }
  return { data, indices };
}

const cases: Array<{ name: string; triangle: readonly [Point, Point, Point]; cellSize: number }> = [
  { name: 'negative cells', triangle: [[-12.25, -3.5, -7.1], [-8.2, -3.5, -7.1], [-12.25, 0.5, -3.1]], cellSize: 1 },
  { name: 'far-field safe cells', triangle: [[2 ** 30, 2 ** 29, 0], [2 ** 30 + 1024, 2 ** 29, 0], [2 ** 30, 2 ** 29 + 1024, 1024]], cellSize: 256 },
  { name: 'positive packed-range boundary', triangle: [[0, 0, 0], [63, 1, 0], [64, 0, 1]], cellSize: 1 },
  { name: 'negative packed-range boundary', triangle: [[0, 0, 0], [-64, 1, 0], [-65, 0, 1]], cellSize: 1 },
  { name: 'tiny cells across safe-integer boundary', triangle: [[1, 0, 0], [2, 1, 0], [0, 0, 1]], cellSize: 2 ** -52 },
  { name: 'unsafe cell anchor', triangle: [[2 ** 80, 0, 0], [2 ** 80 + 2 ** 65, 1, 0], [2 ** 80, 0, 2]], cellSize: 1 },
  { name: 'nonfinite coordinates', triangle: [[NaN, 0, 0], [Infinity, 1, 0], [-Infinity, 0, 1]], cellSize: 1 },
];

describe('issue #3991 exact LOD cell keys', () => {
  for (const { name, triangle, cellSize } of cases) {
    it(`preserves representatives and triangle order for ${name}`, () => {
      const { data, indices } = fixture(triangle);
      const expected = stringCellOracle(data, 7, indices, cellSize);
      assert.ok(expected, 'fixture must produce a nonempty accepted LOD');
      assert.deepEqual(simplifyIndicesByClustering(data, 7, indices, cellSize), expected);
    });
  }

  it('keeps coincident cells from different full-u32 entity lanes isolated', () => {
    const { data, indices } = fixture([[0, 0, 0], [4, 0, 0], [0, 4, 4]]);
    const result = simplifyIndicesByClustering(data, 7, indices, 1);
    assert.ok(result);
    // First survivor belongs to entity 0xffffffff; the next belongs to 1.
    // Even though their positions coincide, each entity elects its own first
    // referenced vertices. These exact representatives are picking identity.
    assert.deepEqual([...result.subarray(0, 6)], [0, 1, 2, 3, 16, 17]);
    assert.deepEqual(result, stringCellOracle(data, 7, indices, 1));
  });

  it('preserves first-reference order when vertices are encountered out of index order', () => {
    const { data, indices } = fixture([[0, 0, 0], [4, 0, 0], [0, 4, 4]]);
    const reversed = new Uint32Array(indices.length);
    for (let t = 0; t < indices.length; t += 3) {
      reversed.set(indices.subarray(indices.length - t - 3, indices.length - t), t);
    }
    const expected = stringCellOracle(data, 7, reversed, 1);
    assert.ok(expected);
    assert.deepEqual(simplifyIndicesByClustering(data, 7, reversed, 1), expected);
  });

  it('preserves supported data without an entity lane', () => {
    const { data, indices } = fixture([[0, 0, 0], [4, 0, 0], [0, 4, 4]], 3);
    const expected = stringCellOracle(data, 3, indices, 1);
    assert.ok(expected);
    assert.deepEqual(simplifyIndicesByClustering(data, 3, indices, 1), expected);
  });
});
