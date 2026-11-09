/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as pc from 'playcanvas';
import { tsImport } from 'tsx/esm/api';
import { createScanLoader } from '../scan-attempt.mjs';
import { nativeScanPoints, playcanvasScanPoints } from '../scan-point-layers.mjs';
const { PointCloudRenderer } = await tsImport('../../../packages/renderer/src/pointcloud/point-cloud-renderer.ts', import.meta.url);

function nativeLayer() {
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  globalThis.GPUBufferUsage = { VERTEX: 32, COPY_DST: 8, COPY_SRC: 4, UNIFORM: 64, STORAGE: 128 };
  const buffers = new Set();
  // Only the GPU boundary is a test device; asset registry, upload and removal
  // execute the real PointCloudRenderer used by the luma backend.
  const device = {
    limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28 },
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createShaderModule: () => ({}),
    createRenderPipeline: () => ({}), createBindGroup: () => ({}), queue: { writeBuffer() {} },
    createBuffer({ size }) {
      const buffer = { size, destroy() { assert.ok(buffers.delete(buffer), 'buffer destroyed exactly once'); } };
      buffers.add(buffer); return buffer;
    },
  };
  const renderer = new PointCloudRenderer(device, 'rgba8unorm', 'depth24plus-stencil8', 1);
  const layer = nativeScanPoints(renderer, () => {});
  return { layer, occupied: () => renderer.getNodeCount(), allocations: () => buffers.size,
    destroy() { layer.clear(); renderer.clear(); } };
}

function playcanvasLayer() {
  const device = new pc.NullGraphicsDevice();
  const app = new pc.AppBase({ id: 'scan-resource-test' });
  const options = new pc.AppOptions(); options.graphicsDevice = device;
  options.componentSystems = [pc.RenderComponentSystem];
  app.init(options);
  const root = new pc.Entity('scan'); app.root.addChild(root);
  const layer = playcanvasScanPoints(device, root, () => {});
  return { layer, occupied: () => root.children.length, allocations: () => device.buffers.size,
    inspect() {
      const instance = root.children[0].render.meshInstances[0];
      for (const resource of [instance.mesh, instance.material, instance.mesh.vertexBuffer]) {
        const destroy = resource.destroy.bind(resource); let calls = 0;
        resource.destroy = () => { assert.equal(++calls, 1, 'resource destroyed exactly once'); destroy(); };
      }
    },
    destroy() { layer.clear(); app.destroy(); } };
}

for (const [name, setup] of [['native luma points', nativeLayer], ['PlayCanvas points', playcanvasLayer]]) {
  test(`${name}: malformed replacement clears real scene/resource state (#8580)`, async () => {
    const backend = setup(), state = {};
    const chunk = { positions: new Float32Array([1, 2, 3]), pointCount: 1, bbox: { min: [1, 2, 3], max: [1, 2, 3] } };
    const loader = createScanLoader({ state, clear: backend.layer.clear,
      read: async file => { JSON.parse(await file.text()); return { chunk, summary: { count: 1 } }; },
      commit: result => backend.layer.replace(result.chunk) });
    const baseline = backend.allocations();
    try {
      await loader.loadScan(new Blob(['{}'])); backend.inspect?.();
      assert.equal(backend.occupied(), 1); assert.equal(backend.layer.count, 1);
      assert.ok(backend.allocations() > baseline);
      await loader.loadScan(undefined);
      assert.equal(backend.occupied(), 1, 'canceled picker preserves current scan');
      const failed = loader.loadScan(new Blob(['malformed']));
      assert.equal(backend.occupied(), 0, 'old scene is detached synchronously');
      assert.equal(backend.layer.count, 0);
      assert.equal(backend.allocations(), baseline, 'old buffers freed before read settles');
      await assert.rejects(failed, SyntaxError);
      assert.equal(state.scan, null); assert.equal(backend.occupied(), 0);
      await loader.loadScan(new Blob(['{}'])); backend.inspect?.();
      assert.equal(backend.occupied(), 1);
      loader.dispose(); loader.dispose(); backend.layer.clear();
      assert.equal(backend.occupied(), 0); assert.equal(backend.layer.count, 0);
      assert.equal(backend.allocations(), baseline);
    } finally { loader.dispose(); backend.destroy(); }
  });
}
