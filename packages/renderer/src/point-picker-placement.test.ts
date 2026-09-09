/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { PointPicker } from './point-picker.js';
import type { WebGPUDevice } from './device.js';

it('keeps independent GPU pick uniforms for differently placed clouds in one pass (#4226)', () => {
  Object.assign(globalThis, { GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 }, GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8 } });
  const buffers: Array<{ data: ArrayBuffer; destroyed: boolean }> = [];
  const device = {
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createShaderModule: () => ({}), createRenderPipeline: () => ({}),
    createBuffer: ({ size }: GPUBufferDescriptor) => {
      const b = { data: new ArrayBuffer(size), destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(b); return b;
    },
    createBindGroup: (descriptor: GPUBindGroupDescriptor) => ({ buffer: (Array.from(descriptor.entries)[0].resource as GPUBufferBinding).buffer }),
    queue: { writeBuffer(buffer: { data: ArrayBuffer }, offset: number, data: ArrayBuffer, start: number, length: number) {
      new Uint8Array(buffer.data).set(new Uint8Array(data, start, length), offset);
    } },
  } as unknown as GPUDevice;
  const picker = new PointPicker({ getDevice: () => device } as WebGPUDevice);
  const draws: Array<{ data: ArrayBuffer }> = [];
  let binding: { buffer: { data: ArrayBuffer } };
  const pass = { setPipeline() {}, setVertexBuffer() {}, setBindGroup(_index: number, group: typeof binding) { binding = group; },
    draw() { draws.push(binding.buffer); } } as unknown as GPURenderPassEncoder;
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const model = identity.slice(); model[12] = 100;
  const nodes = [{ expressId: 7, model, chunks: [{ vertexBuffer: {} as GPUBuffer, pointCount: 1 }] },
    { expressId: 8, chunks: [{ vertexBuffer: {} as GPUBuffer, pointCount: 1 }] }];
  const draw = () => picker.drawIntoPass(pass, nodes, identity, { width: 256, height: 256 },
    { sizeMode: 0, worldRadius: 1, pointSizePx: 4, clickTolerancePx: 2 }, { normal: [1, 0, 0], distance: 101, flipped: false });
  draw();
  // Inspect buffers at submission time, after ALL queue writes, not at write time.
  assert.notEqual(draws[0], draws[1]);
  assert.equal(new Uint32Array(draws[0].data)[24], 7); assert.equal(new Uint32Array(draws[1].data)[24], 8);
  assert.equal(new Float32Array(draws[0].data)[44], 100); assert.equal(new Float32Array(draws[1].data)[44], 0);
  assert.equal(new Float32Array(draws[0].data)[31], 101);
  model[12] = -50; draw();
  assert.equal(new Float32Array(draws[2].data)[44], -50); assert.equal(buffers.length, 2, 'picks reuse uniform buffers');
  picker.destroy(); assert.ok(buffers.every((b) => b.destroyed));
});
