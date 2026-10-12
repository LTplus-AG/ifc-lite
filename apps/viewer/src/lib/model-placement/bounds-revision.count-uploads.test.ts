/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { Scene } from '../../../../../packages/renderer/src/scene.js';
import { flushPlacementGeometry } from './bounds-revision.js';

const realm = globalThis as unknown as { __IFC_LITE_BENCHMARK_UPLOADS?: number };
Object.assign(globalThis, { GPUBufferUsage: { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 } });
afterEach(() => { delete realm.__IFC_LITE_BENCHMARK_UPLOADS; });

it('the viewer benchmark flag changes actual Scene upload grouping (#6993)', () => {
  function run(countMode: number): number {
    realm.__IFC_LITE_BENCHMARK_UPLOADS = countMode;
    let allocations = 0;
    const device = {
      limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
      createBuffer() { allocations++; return { destroy() {} }; },
      queue: { writeBuffer() {} }, createBindGroup() { return {}; },
    } as unknown as GPUDevice;
    const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as NonNullable<ReturnType<Renderer['getPipeline']>>;
    const scene = new Scene();
    scene.queueMeshes([1, 2].map((expressId) => ({
      expressId, modelIndex: 0, color: [1, 1, 1, 1],
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    } as MeshData)));
    assert.equal(flushPlacementGeometry(scene, device, pipeline), true);
    assert.equal(scene.getBatchedMeshes().reduce((sum, batch) => sum + batch.indexCount, 0), 6);
    scene.clear();
    return allocations;
  }
  assert.equal(run(0), 3);
  assert.equal(run(1), 6);
});
