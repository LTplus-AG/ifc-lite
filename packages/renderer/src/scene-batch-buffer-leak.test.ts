/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Scene.createBatchedMesh` allocates a run of GPU buffers for one color
 * batch — vertex, then index, then uniform (and, when LOD1 qualifies, a
 * second index buffer) — with no cleanup if a LATER `createBuffer` call in
 * the same run throws. `appendChunkToNode` (point-cloud-node.ts) and
 * `DeviationPipeline.uploadBvh` guard the exact same shape (see
 * `paired-buffer-leak.test.ts`); `createBatchedMesh` is the batching path
 * every model streams through and was left uncovered.
 *
 * `device.createBuffer` genuinely throws in production — this file's own
 * comments elsewhere (scene.ts:2057, index.ts:168) document a real
 * "createBuffer failed, size (...) is too large" RangeError. When the index
 * buffer's createBuffer throws, the vertex buffer created just before it
 * must be destroyed before the error propagates, or a rebuild loop that
 * retries (rebuildPendingBatches iterates every pending key) leaks one
 * orphaned GPU buffer per failed key.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import type { MeshData } from '@ifc-lite/geometry';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

function fakeBuffer(): GPUBuffer & { destroyed: number } {
  const mapped = new ArrayBuffer(256);
  const buf = {
    size: 0,
    destroyed: 0,
    destroy() { this.destroyed++; },
    getMappedRange: () => mapped,
    unmap() {},
  };
  return buf as unknown as GPUBuffer & { destroyed: number };
}

function meshData(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  } as unknown as MeshData;
}

const fakePipeline = {
  getUniformBufferSize: () => 256,
  getBindGroupLayout: () => ({}),
} as unknown as RenderPipeline;

describe('Scene.createBatchedMesh: paired buffer leak on a mid-run createBuffer throw', () => {
  it('destroys the vertex buffer it already created when the index buffer allocation throws', () => {
    const scene = new Scene();
    const created: Array<GPUBuffer & { destroyed: number }> = [];
    let call = 0;
    const device = {
      limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
      createBuffer: (desc: GPUBufferDescriptor) => {
        call++;
        // 1st call: vertex buffer (mappedAtCreation, succeeds).
        // 2nd call: index buffer — this is where production observes
        // "createBuffer failed, size (...) is too large" on real hardware.
        if (call === 2) {
          throw new RangeError("Failed to execute 'createBuffer' on 'GPUDevice': createBuffer failed");
        }
        const buf = fakeBuffer();
        created.push(buf);
        return buf;
      },
      queue: { writeBuffer: () => {} },
    } as unknown as GPUDevice;

    assert.throws(
      () => scene['createBatchedMesh']([meshData(1)], [1, 1, 1, 1], device, fakePipeline, 'key'),
      /createBuffer failed/,
    );

    assert.strictEqual(created.length, 1, 'vertex buffer should have been created before the throw');
    assert.strictEqual(
      created[0].destroyed, 1,
      'the vertex buffer created before the throw must be destroyed, not orphaned',
    );
  });
});
