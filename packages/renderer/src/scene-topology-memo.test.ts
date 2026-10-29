/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { ModelTranslations } from './model-translation.js';
import { resolvePrecisionBucket, type PrecisionBucket } from './scene-bucket-routing.js';
import { TopologyMemo, topologySafeBatchOrigin } from './scene-precision.js';

function mesh(expressId: number, positions: number[], origin?: [number, number, number]): MeshData {
  const count = positions.length / 3;
  const indices: number[] = [];
  for (let i = 0; i + 2 < count; i++) indices.push(i, i + 1, i + 2);
  return { expressId, color: [0.5, 0.5, 0.5, 1], positions: new Float32Array(positions),
    normals: new Float32Array(positions.length), indices: new Uint32Array(indices), ...(origin ? { origin } : {}) };
}

/** An ordinary quad cluster, an offset one, and a long mesh whose tiny triangle
 * collapses under the bbox-centre rebase (the #6515 shape: only the authored
 * frame keeps it). */
const fixtures = (): MeshData[] => [
  mesh(1, [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  mesh(2, [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0], [1000, 0, -500]),
  mesh(3, [0, 0, 0, 1e-4, 0, 0, 0, 1e-4, 0, 1e7, 0, 0, 1e7, 1e-4, 0]),
  // Small triangles 3e7 away from the first bucket's frame: they collapse
  // there, so routing must split into a second bucket.
  mesh(4, [0, 0, 0, 1e-3, 0, 0, 0, 1e-3, 0], [3e7, 0, 0]),
];

function route(meshes: MeshData[], memo?: TopologyMemo) {
  const buckets = new Map<string, PrecisionBucket>();
  const activeKeys = new Map<string, string>();
  let split = 0;
  const keys = meshes.map((m) => resolvePrecisionBucket({
    buckets, activeKeys, coldKeys: new Set(), maxBufferSize: 1 << 30, sharedOrigin: undefined,
    nextSplitKey: () => `k#${split++}`,
  }, 'k', m, memo));
  return { keys, frames: [...buckets.values()].map((b) => [b.key, b.frameOrigin, b.vertexBytes]) };
}

describe('topology verdict is computed once per (mesh, frame)', () => {
  it('validation then bucket routing scans each mesh once', () => {
    for (const m of fixtures()) {
      const memo = new TopologyMemo();
      const validated = topologySafeBatchOrigin([m], undefined, undefined, undefined, memo);
      const before = memo.scans, hitsBefore = memo.hits;
      resolvePrecisionBucket({
        buckets: new Map(), activeKeys: new Map(), coldKeys: new Set(), maxBufferSize: 1 << 30,
        sharedOrigin: undefined, nextSplitKey: () => 'k#0',
      }, 'k', m, memo);
      assert.ok(before >= 1, 'validation scanned');
      assert.ok(memo.hits > hitsBefore, `routing consulted the memo for mesh ${m.expressId}`);
      assert.strictEqual(memo.scans, before, `routing reused the verdict for mesh ${m.expressId}`);
      assert.ok(validated, `mesh ${m.expressId} has a safe frame`);
    }
  });

  it('routes identically with and without the memo, including a topology-failing mesh', () => {
    const plain = route(fixtures());
    const memoised = route(fixtures(), new TopologyMemo());
    assert.deepStrictEqual(memoised, plain);
    assert.strictEqual(new Set(plain.keys).size, 2, 'the far mesh was split off by the precision check');
  });

  it('chooses the same frame as the unmemoised function', () => {
    for (const m of fixtures()) {
      assert.deepStrictEqual(
        topologySafeBatchOrigin([m], undefined, undefined, undefined, new TopologyMemo()),
        topologySafeBatchOrigin([m], undefined, undefined),
      );
    }
  });
});

describe('placeMesh never copies vertex data', () => {
  it('shares the vertex arrays at zero and non-zero offsets and moves only the origin', () => {
    const translations = new ModelTranslations();
    const source = mesh(9, [0, 0, 0, 1, 0, 0, 0, 1, 0], [5, 6, 7]);
    const zero = translations.placeMesh(source);
    assert.strictEqual(zero.positions, source.positions);
    assert.strictEqual(zero.indices, source.indices);
    assert.deepStrictEqual(zero.origin, [5, 6, 7]);
    translations.set(0, [10, 0, -1]);
    const moved = translations.placeMesh(source);
    assert.strictEqual(moved, zero, 'the placed record is stable so earlier holders see the move');
    assert.strictEqual(moved.positions, source.positions);
    assert.deepStrictEqual(moved.origin, [15, 6, 6]);
    assert.deepStrictEqual(source.origin, [5, 6, 7], 'the source keeps its coordinates');
  });
});
