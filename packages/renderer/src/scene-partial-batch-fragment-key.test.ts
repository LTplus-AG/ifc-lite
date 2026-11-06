/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Partial (hide / isolate) sub-batches of streaming fragments (#9080).
 *
 * A fragment's pieces live in a bucket whose key can carry more than the
 * colour: `<cell>~` (spatial chunking, the viewer default), `model<i>~`,
 * `p<n>~` (ids past 2^24) and `#N` (overflow). Each case builds one of those
 * key shapes; a fragment labelled with the bare colour key found no piece.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import { BATCH_CONSTANTS } from './constants.js';
import { DEFAULT_CHUNK_CELL_SIZE } from './chunk-grid.js';
import type { BatchedMesh } from './types.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

const device = {
  limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
  createBuffer: (desc: GPUBufferDescriptor) => ({ size: desc.size, destroy() {} }),
  createBindGroup: () => ({}),
  queue: { writeBuffer: () => {} },
} as unknown as GPUDevice;

const pipeline = {
  getUniformBufferSize: () => 256,
  getBindGroupLayout: () => ({}),
} as unknown as Parameters<Scene['appendToBatches']>[2];

const GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
const BLUE: [number, number, number, number] = [0.2, 0.3, 0.9, 1];

function triangle(expressId: number, modelIndex: number, x: number, color = GREY): MeshData {
  return {
    expressId,
    modelIndex,
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color,
  };
}

function stream(scene: Scene, meshes: MeshData[]): void {
  scene.appendToBatches(meshes, device, pipeline, true);
}

function fragmentHolding(scene: Scene, expressId: number): BatchedMesh {
  const fragment = scene.getBatchedMeshes().find((batch) => batch.expressIds.includes(expressId));
  assert.ok(fragment, `a streaming fragment draws entity ${expressId}`);
  return fragment;
}

function partialIds(scene: Scene, fragment: BatchedMesh, visible: number[]): number[] {
  const partial = scene.getOrCreatePartialBatch(
    `${fragment.colorKey}:${fragment.id}`, fragment.colorKey, new Set(visible), device, pipeline,
  );
  return partial ? [...new Set(partial.expressIds)].sort((a, b) => a - b) : [];
}

function assertSubsetsDraw(scene: Scene, isolated: number, neighbour: number): void {
  assert.strictEqual(scene.hasStreamingFragments(), true, 'still streaming: the fragment path is live');
  const fragment = fragmentHolding(scene, isolated);
  assert.ok(fragment.expressIds.includes(neighbour), 'both entities share one fragment');
  assert.deepStrictEqual(partialIds(scene, fragment, [isolated]), [isolated], 'isolate draws the isolated entity');
  assert.deepStrictEqual(partialIds(scene, fragment, [neighbour]), [neighbour], 'hide keeps the same-colour neighbour');
}

describe('Scene.getOrCreatePartialBatch on streaming fragments', () => {
  it('first model, plain colour key', () => {
    const scene = new Scene();
    stream(scene, [triangle(1, 0, 0), triangle(2, 0, 2)]);
    assertSubsetsDraw(scene, 1, 2);
  });

  it('second federated model (model1~ key)', () => {
    const scene = new Scene();
    stream(scene, [triangle(10, 0, 0, BLUE)]);
    stream(scene, [triangle(1_000_001, 1, 0), triangle(1_000_002, 1, 2)]);
    assertSubsetsDraw(scene, 1_000_001, 1_000_002);
  });

  it('second federated model sharing a colour with the first', () => {
    const scene = new Scene();
    stream(scene, [triangle(10, 0, 0)]);
    stream(scene, [triangle(1_000_001, 1, 0), triangle(1_000_002, 1, 2)]);
    assertSubsetsDraw(scene, 1_000_001, 1_000_002);
  });

  it('first model with spatial chunking on (<cell>~ key, the viewer default)', () => {
    const scene = new Scene();
    scene.setSpatialChunking({ cellSize: DEFAULT_CHUNK_CELL_SIZE });
    stream(scene, [triangle(1, 0, 0), triangle(2, 0, 2)]);
    assertSubsetsDraw(scene, 1, 2);
  });

  it('ids past 2^24 (p1~ id page key)', () => {
    const scene = new Scene();
    const base = 0x1000000;
    stream(scene, [triangle(base + 1, 0, 0), triangle(base + 2, 0, 2)]);
    assertSubsetsDraw(scene, base + 1, base + 2);
  });

  for (const modelIndex of [0, 1]) it(`overflow bucket (#N key), model ${modelIndex}`, () => {
    const scene = new Scene();
    // Room for two triangles per bucket: the second append overflows into `<base>#0`.
    scene['cachedMaxBufferSize'] = 2 * 3 * BATCH_CONSTANTS.BYTES_PER_VERTEX;
    const id = (n: number) => modelIndex * 1_000_000 + n;
    stream(scene, [triangle(id(1), modelIndex, 0), triangle(id(2), modelIndex, 2)]);
    stream(scene, [triangle(id(3), modelIndex, 4), triangle(id(4), modelIndex, 6)]);
    assertSubsetsDraw(scene, id(3), id(4));
  });
});
