/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { simplifyIndicesByClustering, LOD_MIN_TRIANGLES, PackedCellTable } from './lod-simplify.js';

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

/** The multiplicative inverse of an odd 32-bit constant (Newton iteration). */
function inverseOf(odd: number): number {
  let inverse = 1;
  for (let i = 0; i < 5; i++) inverse = Math.imul(inverse, 2 - Math.imul(odd, inverse));
  return inverse;
}

/** Undo `x ^ (x >>> shift)` on 32 bits. */
function unshift(y: number, shift: number): number {
  let x = y;
  for (let i = 0; i < 32; i += shift) x = y ^ (x >>> shift);
  return x >>> 0;
}

/**
 * Valid keys whose table hash shares its low 24 bits, so every key starts the
 * same probe chain. `original` targets #9685's first table hash (the review's
 * reproducer); otherwise the shipped `hashCell` mix is inverted step by step.
 * Cells lie on a 64×64×n grid at cellSize 1 from (0,0,0); entity lanes are
 * arbitrary u32 values, as id + colour salt can be. Returns [entity, packed cell, x, y, z].
 */
function collidingKeys(n: number, original = false): Array<[number, number, number, number, number]> {
  return Array.from({ length: n }, (_, i) => {
    const x = i % 64, y = Math.floor(i / 64) % 64, z = Math.floor(i / 4096);
    const packed = (x + 64) * 0x4000 + (y + 64) * 0x80 + z + 64;
    const cellPart = Math.imul(packed + 1, 0x85ebca6b);
    if (original) return [(Math.imul(inverseOf(0x9e3779b1), cellPart) & 0xffffff) >>> 0, packed, x, y, z];
    // hashCell(entity, cell) = fmix(imul(entity ^ cellPart, φ)); aim every output at (i << 24) | 0x5a5a5a.
    let h = ((i << 24) | 0x5a5a5a) >>> 0;
    h = unshift(h, 16); h = Math.imul(h, inverseOf(0xc2b2ae35));
    h = unshift(h, 13); h = Math.imul(h, inverseOf(0x85ebca6b));
    h = unshift(h, 16);
    return [(Math.imul(h, inverseOf(0x9e3779b1)) ^ cellPart) >>> 0, packed, x, y, z];
  });
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

  it('avoids per-cell string keys while simplifying an eligible finite mesh (#3991)', () => {
    const { data, indices } = fixture([[0, 0, 0], [4, 0, 0], [0, 4, 4]]);
    // Build the independent tuple oracle before observing the real simplifier:
    // the oracle intentionally allocates string keys, unlike the eligible path.
    const expected = stringCellOracle(data, 7, indices, 1);
    assert.ok(expected);
    const originalSet = Map.prototype.set;
    let stringInsertions = 0;
    let numericInsertions = 0;
    let result: Uint32Array | null;
    // Transparent, synchronous observation: preserve every key, value, receiver
    // and return value. No await or assertion runs with the global hook installed.
    Map.prototype.set = function <K, V>(this: Map<K, V>, key: K, value: V) {
      if (typeof key === 'string') stringInsertions++;
      if (typeof key === 'number') numericInsertions++;
      return originalSet.call(this, key, value);
    };
    try {
      result = simplifyIndicesByClustering(data, 7, indices, 1);
    } finally {
      Map.prototype.set = originalSet;
    }
    assert.ok(result, 'the observed call must produce an accepted LOD');
    assert.equal(result.length, 120 * 3, 'the mesh must actually lose collapsed triangles');
    assert.deepEqual(result, expected, 'numeric cells preserve first representatives and entity lanes');
    // Packed neighbourhood cells live in a typed table, so not even a numeric
    // Map key (a boxed 53-bit double) is allocated per occupied cell.
    assert.equal(numericInsertions, 0, 'no Map entry for the six occupied cells (three per entity lane)');
    assert.equal(stringInsertions, 0, 'eligible cells must use no string map keys');
  });

  it('matches the oracle when the packed cell table grows past its first allocation', () => {
    // 80k small triangles over 7 entity lanes occupy ~100k cells: the table
    // starts at 2^17 slots and must rehash while keeping first representatives.
    const triangles = 80_000;
    const data = new Float32Array(triangles * 3 * 7);
    const lanes = new Uint32Array(data.buffer);
    let seed = 7;
    const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    for (let t = 0; t < triangles; t++) {
      const cx = random() * 60, cy = random() * 60, cz = random() * 20;
      for (let corner = 0; corner < 3; corner++) {
        const v = t * 3 + corner;
        data[v * 7] = cx + random() * 0.6; data[v * 7 + 1] = cy + random() * 0.6; data[v * 7 + 2] = cz + random() * 0.6;
        lanes[v * 7 + 6] = 0x8000_0000 + (t % 7);
      }
    }
    const indices = Uint32Array.from({ length: triangles * 3 }, (_, i) => i);
    const expected = stringCellOracle(data, 7, indices, 1);
    assert.ok(expected && expected.length < indices.length, 'a non-trivial LOD');
    assert.deepEqual(simplifyIndicesByClustering(data, 7, indices, 1), expected);
  });

  for (const original of [true, false]) {
    it(`keeps probing linear when valid keys all collide (${original ? "the review's keys" : 'keys aimed at the shipped hash'}), with first-wins representatives`, () => {
      const keys = collidingKeys(16_386, original);
      const table = new PackedCellTable(Math.min(keys.length >> 1, 1 << 16));
      let operations = 0;
      keys.forEach(([entity, cell], rep) => {
        operations += 2;
        assert.ok(table.find(entity, cell) === -1, 'every key is new');
        table.insert(entity, cell, rep);
      });
      keys.forEach(([entity, cell], rep) => { operations++; assert.ok(table.find(entity, cell) === rep, `representative of key ${rep}`); });
      // The unbounded chain probed 268.5 million slots for the review's keys.
      assert.ok(table.probes <= operations * 16 + 4096 + keys.length * 2, `${table.probes} probes for ${operations} operations`);
      if (!original) assert.ok(table.overflowed, 'the colliding chain moved to the exact map');
    });
  }

  it('matches the oracle through the collision fallback, null and non-null', () => {
    const keys = collidingKeys(8_193);
    // These keys are aimed at the shipped hash, so this exercises the exact-map fallback.
    for (const duplicate of [false, true]) {
      // Each key's vertex once (nothing collapses: null), or twice with every
      // other triangle degenerate (a non-null LOD that drops half).
      const per = duplicate ? 2 : 1;
      const data = new Float32Array(keys.length * per * 7);
      const lanes = new Uint32Array(data.buffer);
      keys.forEach(([entity, , x, y, z], k) => {
        for (let copy = 0; copy < per; copy++) {
          const v = k * per + copy;
          data[v * 7] = x; data[v * 7 + 1] = y; data[v * 7 + 2] = z; lanes[v * 7 + 6] = entity;
        }
      });
      const indices: number[] = [];
      for (let k = 0; k + 2 < keys.length; k++) {
        if (duplicate) indices.push(k * 2, k * 2 + 1, (k + 1) * 2, k * 2, (k + 1) * 2, (k + 2) * 2);
        else indices.push(k, k + 1, k + 2);
      }
      const index = Uint32Array.from(indices);
      const expected = stringCellOracle(data, 7, index, 1);
      assert.ok((expected === null) === !duplicate, 'one null and one non-null case');
      assert.deepEqual(simplifyIndicesByClustering(data, 7, index, 1), expected);
    }
  });

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
