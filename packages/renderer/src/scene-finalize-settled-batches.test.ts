/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Settled geometry keeps drawing through a finalize that rebuilds nothing (#9154).
 *
 * Model A is settled. Model B streams in, and every streamed mesh of B is
 * removed before B's first finalize. The regroup then only dissolves B's empty
 * bucket and leaves no key pending. The finalize must still publish A's batch:
 * nothing pending means a caller gating a rebuild on `hasPendingBatches()`
 * never brings A back. Both finalize paths are covered, for a B in A's colour
 * and in a colour A does not use.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

type FakeBuffer = { size: number; destroyed: boolean; destroy(): void };

const device = {
  limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
  createBuffer: (desc: GPUBufferDescriptor): FakeBuffer => ({
    size: desc.size, destroyed: false, destroy() { this.destroyed = true; },
  }),
  createBindGroup: () => ({}),
  queue: { writeBuffer: () => {} },
} as unknown as GPUDevice;

const pipeline = {
  getUniformBufferSize: () => 256,
  getBindGroupLayout: () => ({}),
} as unknown as Parameters<Scene['appendToBatches']>[2];

const GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
const BLUE: [number, number, number, number] = [0.2, 0.3, 0.9, 1];
const A = 1;
const B = 2;

function triangle(expressId: number, color: [number, number, number, number]): MeshData {
  return {
    expressId,
    modelIndex: 0,
    positions: new Float32Array([expressId, 0, 0, expressId + 1, 0, 0, expressId, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color,
  };
}

/** How many live (not destroyed) batches in the draw list carry `expressId`. */
function timesDrawn(scene: Scene, expressId: number): number {
  return scene.getBatchedMeshes().filter((batch) =>
    batch.expressIds.includes(expressId)
    && !(batch.vertexBuffer as unknown as FakeBuffer).destroyed
    && !(batch.indexBuffer as unknown as FakeBuffer).destroyed,
  ).length;
}

const finalizers = {
  sync: (scene: Scene) => { scene.finalizeStreaming(device, pipeline); },
  async: (scene: Scene) => scene.finalizeStreamingAsync(device, pipeline),
};

describe('finalize with every streamed mesh removed keeps settled geometry drawn (#9154)', () => {
  for (const [path, finalize] of Object.entries(finalizers)) {
    for (const [label, colour] of [['other colour', BLUE], ['same colour', GREY]] as const) {
      it(`${path} finalize, B in ${label}`, async () => {
        const scene = new Scene();
        scene.appendToBatches([triangle(A, GREY)], device, pipeline, false); // A settles
        assert.strictEqual(timesDrawn(scene, A), 1, 'A is drawn once it settles');

        scene.appendToBatches([triangle(B, colour)], device, pipeline, true); // B streams
        scene.removeMeshesForEntity(B); // before B's first finalize
        await finalize(scene);

        assert.strictEqual(timesDrawn(scene, A), 1, 'A is still drawn, exactly once');
        assert.strictEqual(timesDrawn(scene, B), 0, 'removed B is not drawn');
        assert.strictEqual(scene.hasStreamingFragments(), false, 'the finalize settled the stream');
      });
    }
  }
});
