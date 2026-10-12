/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { diffCounters, perfCounters } from '@ifc-lite/load-trace';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';

Object.assign(globalThis, { GPUBufferUsage: { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 } });

/** Actual Scene fragment creation and GPU upload payloads; only the native
 * device is substituted. Every input triangle must reach exactly one draw. */
function cohort(arrivals: number[], cost: number, countMode: boolean, indicesPerMesh = 3) {
  perfCounters.enable();
  const before = perfCounters.read();
  let clock = 0;
  let buffers = 0;
  let bytes = 0;
  let uploads = 0;
  mock.method(performance, 'now', () => clock);
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer(descriptor: GPUBufferDescriptor) {
      buffers++;
      bytes += descriptor.size;
      clock += cost;
      return { size: descriptor.size, usage: descriptor.usage, destroy() {} };
    },
    queue: { writeBuffer(_buffer: unknown, _offset: number, data: ArrayBufferView) { uploads += data.byteLength; } },
    createBindGroup() { return {}; },
  } as unknown as GPUDevice;
  const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;
  const scene = new Scene();
  let id = 1;
  let calls = 0;
  for (const length of arrivals) {
    const meshes = Array.from({ length }, () => ({
      expressId: id++, modelIndex: 0,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: Uint32Array.from({ length: indicesPerMesh }, (_, i) => i % 3), color: [1, 1, 1, 1],
    } as MeshData));
    scene.queueMeshes(meshes);
    while (scene.hasQueuedMeshes()) {
      assert.equal(scene.flushPending(device, pipeline, 0, undefined, countMode), true);
      calls++;
    }
  }
  const batches = scene.getBatchedMeshes();
  assert.equal(batches.reduce((n, batch) => n + batch.indexCount, 0), (id - 1) * indicesPerMesh);
  assert.deepEqual([...new Set(batches.flatMap((batch) => batch.expressIds))].sort((a, b) => a - b), Array.from({ length: id - 1 }, (_, i) => i + 1));
  scene.clear();
  const counters = diffCounters(perfCounters.read(), before);
  assert.equal(counters['gpu.staticUpload.bytes'], uploads, 'the shared meter reports the bytes actually submitted');
  assert.equal(counters['gpu.staticUpload.count'], buffers / 3 * 2, 'each real batch has a static vertex and index upload');
  return { buffers, bytes, uploads, calls };
}

describe('count-based streaming uploads (#6993)', () => {
  afterEach(() => mock.restoreAll());
  it('keeps GPU allocation/upload totals identical across different arrivals and clocks', () => {
    const a = cohort([20], 0, true);
    const b = cohort([7, 13], 100, true);
    assert.equal(a.buffers, 60);
    assert.deepEqual({ buffers: a.buffers, bytes: a.bytes, uploads: a.uploads }, { buffers: b.buffers, bytes: b.bytes, uploads: b.uploads });
  });

  it('bounds count slices even when the clock never advances', () => {
    const result = cohort([1025], 0, true);
    assert.equal(result.calls, 3, 'at most 512 meshes per count slice');
    assert.equal(result.buffers, 3075);
  });

  it('bounds aggregate triangle work per count slice while preserving oversize progress', () => {
    const cap = Scene['STREAMING_FRAGMENT_MAX_INDICES'];
    const aboveHalf = Math.floor(cap / 6) * 3 + 3;
    assert.equal(cohort([3], 0, true, aboveHalf).calls, 3);
    assert.equal(cohort([2], 0, true, cap + 3).calls, 4, 'queueMeshes splits each oversize input into a full fragment and a tail; neither tail can share a capped slice with a full fragment');
  });

  it('retains the original grouped upload workload when count mode is off', () => {
    const grouped = cohort([20], 100, false);
    const separated = cohort([7, 13], 100, false);
    assert.equal(grouped.buffers, 3);
    assert.equal(separated.buffers, 6);
  });
});
