/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from '../../../../packages/renderer/src/scene.js';

/** Real Scene ownership with only WebGPU allocation calls stubbed. Input is the
 * explicit native IFC fixture used by the mounted appearance tests: one triangle
 * by default, or the caller's shared template (#4404 face masks use a quad). */
export function appearanceInstanceScene(originals: readonly MeshData[],
  template: { positions: Float32Array; normals: Float32Array; indices: Uint32Array } = {
    positions: new Float32Array([0,0,0,1,0,0,0,1,0]), normals: new Float32Array([0,0,1,0,0,1,0,0,1]), indices: new Uint32Array([0,1,2]) }) {
  Object.assign(globalThis, { GPUBufferUsage: { COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64 },
    GPUTextureUsage: { COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 } });
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: ({ size }: GPUBufferDescriptor) => {
      const data = new ArrayBuffer(size);
      return { size, getMappedRange: () => data, unmap() {}, destroy() {} };
    },
    createBindGroup: () => ({}), createSampler: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    queue: { writeBuffer() {}, writeTexture() {}, copyExternalImageToTexture() {} },
  } as unknown as GPUDevice;
  const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}),
    createTexturedBindGroup: () => ({}) } as unknown as Parameters<Scene['appendToBatches']>[2];
  const scene = new Scene();
  scene.addInstancedShard(device, { carriesItemIds: true,
    templates: [{ positions: template.positions, normals: template.normals, indices: template.indices, origin: [0,0,0] }],
    instances: originals.map(mesh => ({ entityId: mesh.expressId, itemId: mesh.geometryItemId, templateIndex: 0,
      color: mesh.color, transform: new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]) })),
  }, originals[0].modelIndex!);
  return { scene, device, pipeline, preview: scene.appearancePreview(device, pipeline) };
}
