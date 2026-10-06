/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { PointCloudRenderer } from './pointcloud/point-cloud-renderer.js';

(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
(globalThis as Record<string, unknown>).GPUBufferUsage = { VERTEX: 32, COPY_DST: 8, COPY_SRC: 4, UNIFORM: 64, STORAGE: 128 };
function pointDevice(): GPUDevice {
  return { limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28, maxComputeWorkgroupsPerDimension: 65_535 },
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createShaderModule: () => ({}),
    createRenderPipeline: () => ({}), createBindGroup: () => ({}),
    createBuffer: ({ size }: GPUBufferDescriptor) => ({ size, destroy() {} }), queue: { writeBuffer() {} },
  } as unknown as GPUDevice;
}

it('binds a streamed asset to its federated id and model index for picks and snaps (#6887)', () => {
  const renderer = new PointCloudRenderer(pointDevice(), 'rgba8unorm', 'depth32float', 1);
  // A streamed asset opens before its model is registered: local id, no index.
  const handle = renderer.beginAsset({ expressId: 3, ifcType: 'IfcGeographicElement' });
  renderer.appendChunk(handle, { pointCount: 1, positions: new Float32Array([1, 2, 3]), bbox: { min: [1, 2, 3], max: [1, 2, 3] } });
  assert.equal(renderer.getPickNodes()[0].modelIndex, undefined);

  renderer.relabelAsset(handle, 1_000_003, 2);
  const identity = (n: { expressId: number; modelIndex?: number }) => ({ expressId: n.expressId, modelIndex: n.modelIndex });
  assert.deepEqual(renderer.getPickNodes().map(identity), [{ expressId: 1_000_003, modelIndex: 2 }]);
  assert.deepEqual(renderer.getRayQuerySources().map(identity), [{ expressId: 1_000_003, modelIndex: 2 }]);
  assert.equal(renderer.resolvePick(1_000_003)?.meta.modelIndex, 2);

  // The id-only form stays a pure relabel: it never clears a bound index.
  renderer.relabelAsset(handle, 1_000_004);
  assert.deepEqual(renderer.getPickNodes().map(identity), [{ expressId: 1_000_004, modelIndex: 2 }]);
  renderer.clear();
});
