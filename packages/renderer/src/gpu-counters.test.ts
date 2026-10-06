/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { MeshData } from '@ifc-lite/geometry';
import { diffCounters, perfCounters } from '@ifc-lite/load-trace';
import { meterGpuDevice } from './gpu-counters.js';
import { mergeGeometry } from './scene-geometry.js';

function fakeDevice() {
  const created: GPUBufferDescriptor[] = [];
  const writes: unknown[][] = [];
  const queue = { writeBuffer: (...args: unknown[]) => { writes.push(args); } };
  const device = {
    queue,
    createBuffer: (d: GPUBufferDescriptor) => { created.push(d); return { usage: d.usage, size: d.size } as unknown as GPUBuffer; },
  };
  return { device: device as unknown as GPUDevice, created, writes };
}

const tri = (id: number): MeshData => ({
  expressId: id,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  color: [1, 1, 1, 1],
}) as MeshData;

describe('GPU and merge counters (#6957)', () => {
  it('is the identity while counters are off', () => {
    const { device } = fakeDevice();
    const createBuffer = device.createBuffer;
    assert.strictEqual(meterGpuDevice(device), device);
    assert.strictEqual(device.createBuffer, createBuffer);
  });

  it('counts buffer creations, mapped uploads and writes, keeping uniform writes apart', () => {
    perfCounters.enable();
    const { device, created, writes } = fakeDevice();
    meterGpuDevice(device);
    const before = perfCounters.read();
    const vertex = device.createBuffer({ size: 1024, usage: 0x20, mappedAtCreation: true }); // VERTEX
    const uniform = device.createBuffer({ size: 64, usage: 0x40 | 0x08 }); // UNIFORM | COPY_DST
    device.queue.writeBuffer(vertex, 0, new Float32Array(16)); // 64 B
    device.queue.writeBuffer(vertex, 0, new Uint32Array(10), 2, 4); // 4 elements = 16 B
    device.queue.writeBuffer(uniform, 0, new Float32Array(16));
    assert.strictEqual(created.length, 2); // the real calls still happen
    assert.strictEqual(writes.length, 3);
    assert.deepStrictEqual(diffCounters(perfCounters.read(), before), {
      'gpu.buffers': 2,
      'gpu.bufferBytes': 1088,
      'gpu.mappedUploadBytes': 1024,
      'gpu.writeBytes': 80,
      'gpu.uniformWriteBytes': 64,
    });
  });

  it('counts each mergeGeometry call and the vertices it merged', () => {
    perfCounters.enable();
    const before = perfCounters.read();
    mergeGeometry([tri(1), tri(2)]);
    mergeGeometry([tri(3)]);
    const delta = diffCounters(perfCounters.read(), before);
    assert.strictEqual(delta['render.mergeGeometry.count'], 2);
    assert.strictEqual(delta['render.mergeGeometry.vertices'], 9);
  });
});
