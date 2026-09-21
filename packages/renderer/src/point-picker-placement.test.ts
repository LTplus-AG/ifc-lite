/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { PointPicker } from './point-picker.js';
import type { WebGPUDevice } from './device.js';
import { RelativeToEyeFrame } from './relative-to-eye.js';
import { MathUtils } from './math.js';

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

it('packs a point-pick origin relative to the immutable camera frame (#5049)', () => {
  Object.assign(globalThis, { GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 }, GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8 } });
  const writes: Float32Array[] = [];
  const device = {
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createShaderModule: () => ({}), createRenderPipeline: () => ({}),
    createBuffer: () => ({ destroy() {} }), createBindGroup: () => ({}),
    queue: { writeBuffer(_buffer: GPUBuffer, _offset: number, data: Float32Array) { writes.push(new Float32Array(data)); } },
  } as unknown as GPUDevice;
  const picker = new PointPicker({ getDevice: () => device } as WebGPUDevice);
  const pass = { setPipeline() {}, setVertexBuffer() {}, setBindGroup() {}, draw() {} } as unknown as GPURenderPassEncoder;
  const frame = new RelativeToEyeFrame();
  frame.update({ x: 5_000_000, y: 0, z: 10 }, MathUtils.identity(), MathUtils.identity());
  picker.drawIntoPass(pass, [{
    expressId: 7,
    model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5_000_000, 0, 0, 1]),
    rteOrigin: [5_000_000.025, 0, 0],
    chunks: [{ vertexBuffer: {} as GPUBuffer, pointCount: 1 }],
  }], new Float32Array(MathUtils.identity().m), { width: 256, height: 256 },
  { sizeMode: 0, worldRadius: 1, pointSizePx: 4, clickTolerancePx: 2 }, null, frame.snapshot());
  const packed = writes[0];
  assert.ok(packed, 'picker writes one RTE uniform block');
  assert.equal(new Uint32Array(packed.buffer)[27], 1);
  assert.equal(packed[48], 0.02500000037252903);
  assert.equal(packed[44], 0, 'translation is excluded from the f32 model lane');
  picker.destroy();
});

it('packs an RTE-relative crop box for both click and marquee point picks (#5049)', () => {
  Object.assign(globalThis, { GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 }, GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8 } });
  const writes: Float32Array[] = [];
  const device = {
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createShaderModule: () => ({}), createRenderPipeline: () => ({}),
    createBuffer: () => ({ destroy() {} }), createBindGroup: () => ({}),
    queue: { writeBuffer(_buffer: GPUBuffer, _offset: number, data: Float32Array) { writes.push(new Float32Array(data)); } },
  } as unknown as GPUDevice;
  const picker = new PointPicker({ getDevice: () => device } as WebGPUDevice);
  const pass = { setPipeline() {}, setVertexBuffer() {}, setBindGroup() {}, draw() {} } as unknown as GPURenderPassEncoder;
  const frame = new RelativeToEyeFrame();
  frame.update({ x: 5_000_000, y: 20, z: -10 }, MathUtils.identity(), MathUtils.identity());
  picker.drawIntoPass(pass, [{ expressId: 7, rteOrigin: [5_000_000.015625, 20, -10], chunks: [{ vertexBuffer: {} as GPUBuffer, pointCount: 1 }] }],
    new Float32Array(MathUtils.identity().m), { width: 256, height: 256 },
    { sizeMode: 0, worldRadius: 1, pointSizePx: 4, clickTolerancePx: 2 }, null, frame.snapshot(),
    { enabled: true, min: [5_000_000.01, 19, -11], max: [5_000_000.02, 21, -9] });
  const packed = writes[0];
  assert.equal(new Uint32Array(packed.buffer)[27], 3, 'RTE and crop bits are both enabled');
  assert.equal(packed[56], 0.009999999776482582);
  assert.equal(packed[60], 0.019999999552965164);
  picker.destroy();
});

it('keeps the 16-vec4 pick ABI and does not add a translated model origin twice (#5152)', () => {
  Object.assign(globalThis, { GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 }, GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8 } });
  const writes: Float32Array[] = [];
  const allocations: number[] = [];
  const device = {
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createShaderModule: () => ({}), createRenderPipeline: () => ({}),
    createBuffer: ({ size }: GPUBufferDescriptor) => { allocations.push(size); return { destroy() {} }; }, createBindGroup: () => ({}),
    queue: { writeBuffer(_buffer: GPUBuffer, _offset: number, data: Float32Array) { writes.push(new Float32Array(data)); } },
  } as unknown as GPUDevice;
  const picker = new PointPicker({ getDevice: () => device } as WebGPUDevice);
  const pass = { setPipeline() {}, setVertexBuffer() {}, setBindGroup() {}, draw() {} } as unknown as GPURenderPassEncoder;
  const frame = new RelativeToEyeFrame();
  frame.update({ x: 5_000_000, y: 20, z: -10 }, MathUtils.identity(), MathUtils.identity());
  const model = new Float32Array([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5_000_000, 20, -10, 1]);
  picker.drawIntoPass(pass, [{ expressId: 7, model, rteOrigin: [5_000_000.025, 20, -10], chunks: [{ vertexBuffer: {} as GPUBuffer, pointCount: 1 }] }],
    new Float32Array(MathUtils.identity().m), { width: 256, height: 128 },
    { sizeMode: 2, worldRadius: 3, pointSizePx: 6, clickTolerancePx: 2 }, { normal: [1, 0, 0], distance: 5_000_003, flipped: false }, frame.snapshot(),
    { enabled: true, min: [5_000_000.01, 19, -11], max: [5_000_000.02, 21, -9] });

  const packed = writes[0]!;
  const words = new Uint32Array(packed.buffer);
  assert.deepEqual(allocations, [256], 'U is exactly 16 vec4 slots, not a stale larger ABI');
  assert.equal(packed.length, 64, 'the uploaded U block covers every WGSL field exactly once');
  assert.deepEqual([...packed.slice(20, 24)], [2, 3, 6, 2], 'sizing starts at float 20');
  assert.deepEqual([...words.slice(24, 28)], [7, 1, 0, 3], 'entity/section/RTE/crop flags occupy float 24');
  assert.equal(packed[28], 1, 'section starts at float 28');
  assert.equal(packed[31], 3, 'section distance is camera-relative');
  assert.equal(packed[32], 2, 'the linear model starts at float 32');
  assert.deepEqual([...packed.slice(44, 47)], [0, 0, 0], 'absolute translation is excluded from the model lane');
  assert.ok(Math.abs((packed[32] * 0.125 + packed[48] + packed[52]) - 0.275) < 1e-6,
    'a local x=0.125 point projects as 2*0.125 + (origin-camera), without a second map-grid translation');
  assert.ok(Math.abs(packed[56] - 0.01) < 1e-6 && Math.abs(packed[60] - 0.02) < 1e-6,
    'RTE crop min/max remain at floats 56/60 after the drawable lanes');
  picker.destroy();
});
