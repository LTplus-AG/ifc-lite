/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564: addMesh, ensureMeshResources and the selection highlight share one
// per-mesh uniform allocation. These observe the allocation each draw relies on:
// a buffer of the pipeline's uniform size and a group(0) bind group over it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureMeshUniform } from './mesh-uniform-resources.js';
import { Renderer } from './index.js';

(globalThis as Record<string, unknown>).GPUBufferUsage ??= { COPY_DST: 8, UNIFORM: 64, VERTEX: 32, INDEX: 16, STORAGE: 128, COPY_SRC: 4, MAP_READ: 1 };
(globalThis as Record<string, unknown>).GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
(globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

interface Recorded { buffers: GPUBufferDescriptor[]; groups: GPUBindGroupDescriptor[] }
function recordingDevice(): { device: GPUDevice; recorded: Recorded } {
  const recorded: Recorded = { buffers: [], groups: [] };
  const device = {
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 1 << 28 },
    queue: { writeBuffer() {} },
    createBuffer(descriptor: GPUBufferDescriptor) { recorded.buffers.push(descriptor); return { descriptor, destroy() {} }; },
    createBindGroup(descriptor: GPUBindGroupDescriptor) { recorded.groups.push(descriptor); return { descriptor }; },
  };
  return { device: device as unknown as GPUDevice, recorded };
}
const LAYOUT = { label: 'main-group-0' } as unknown as GPUBindGroupLayout;
const pipeline = { getUniformBufferSize: () => 240, getBindGroupLayout: () => LAYOUT };
const mesh = (expressId: number) => ({
  expressId, vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3,
  transform: { m: new Float32Array(16) }, color: [0.5, 0.5, 0.5, 1] as [number, number, number, number],
});
const bufferOf = (group: GPUBindGroupDescriptor) => {
  const entries = [...group.entries];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].binding, 0);
  return (entries[0].resource as GPUBufferBinding).buffer;
};

test('#8564 ensureMeshUniform allocates one uniform buffer and its group(0) bind group, once', () => {
  const { device, recorded } = recordingDevice();
  const target: { uniformBuffer?: GPUBuffer; bindGroup?: GPUBindGroup } = {};
  ensureMeshUniform(device, pipeline, target);
  assert.deepEqual(recorded.buffers, [{ size: 240, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }]);
  assert.equal(recorded.groups.length, 1);
  assert.equal(recorded.groups[0].layout, LAYOUT);
  assert.equal(bufferOf(recorded.groups[0]), target.uniformBuffer);
  assert.ok(target.bindGroup);
  ensureMeshUniform(device, pipeline, target);
  assert.equal(recorded.buffers.length, 1, 'an existing uniform buffer is kept');
});

function rendererWith(device: GPUDevice): Renderer {
  const canvas = { width: 64, height: 64, getBoundingClientRect: () => ({ width: 64, height: 64 }), style: {} } as unknown as HTMLCanvasElement;
  const renderer = new Renderer(canvas);
  const fields = renderer as unknown as Record<string, unknown>;
  fields.device = { isInitialized: () => true, getDevice: () => device, onDeviceLost: () => {}, destroy: () => {} };
  fields.pipeline = pipeline;
  return renderer;
}

test('#8564 addMesh and ensureMeshResources give each individual mesh its own bound uniform', () => {
  const { device, recorded } = recordingDevice();
  const renderer = rendererWith(device);
  const first = mesh(1);
  assert.deepEqual(renderer.addMesh(first as never), { ok: true, value: undefined });
  assert.equal(recorded.buffers.length, 1);
  assert.equal(bufferOf(recorded.groups[0]), (first as { uniformBuffer?: GPUBuffer }).uniformBuffer);
  assert.equal((first as { bindGroup?: unknown }).bindGroup !== undefined, true);

  const second = mesh(2);
  renderer.getScene().addMesh(second as never); // registered without GPU resources
  assert.deepEqual(renderer.ensureMeshResources(), { ok: true, value: undefined });
  assert.equal(recorded.buffers.length, 2, 'only the mesh without resources is allocated');
  assert.equal(bufferOf(recorded.groups[1]), (second as { uniformBuffer?: GPUBuffer }).uniformBuffer);
  renderer.ensureMeshResources();
  assert.equal(recorded.buffers.length, 2, 'a second pass allocates nothing');
});
