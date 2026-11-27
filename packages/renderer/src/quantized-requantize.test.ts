/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import { requantizeEarlyBatches } from './quantized-requantize.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

const device = {
  limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
  createBuffer: (desc: GPUBufferDescriptor) => ({ size: desc.size, destroy() {} }),
  createBindGroup: () => ({}),
  queue: { writeBuffer: () => {} },
} as unknown as GPUDevice;
const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as Parameters<Scene['appendToBatches']>[2];

/** A 1 m square of two triangles at `x`, colour by id. */
function square(expressId: number, x: number, size = 1): MeshData {
  return {
    expressId, modelIndex: 0, color: [expressId / 10, 0.5, 0.5, 1],
    positions: new Float32Array([x, 0, 0, x + size, 0, 0, x + size, size, 0, x, size, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

const quantizedBatches = (scene: Scene) => scene.getBatchedMeshes().filter((batch) => batch.quantized).length;

describe('requantizeEarlyBatches (the quantized pipeline probe resolved after batches were built)', () => {
  it('rebuilds the bucket batches built without quantized pipelines, quantized', () => {
    const scene = new Scene();
    scene.appendToBatches([square(1, 0), square(2, 3)], device, pipeline, false);
    assert.equal(scene.getBatchedMeshes().length, 2);
    assert.equal(quantizedBatches(scene), 0, 'built before the probe resolved: f32');
    scene.setQuantizedBatches(true);
    const revision = scene.getPickGeometryRevision();
    assert.equal(requantizeEarlyBatches(scene, () => device, pipeline), 2);
    assert.ok(scene.getPickGeometryRevision() > revision, 'highlight copies are made again on the new lattice');
    assert.equal(scene.hasPendingBatches(), false, 'rebuilt at once: no stream to wait for');
    assert.equal(quantizedBatches(scene), 2, 'as a load after the probe draws them');
    assert.equal(requantizeEarlyBatches(scene, () => device, pipeline), 0, 'the rebuilt batches are not marked again');
  });

  it('reports zero rebuilt when the device is unavailable and retries the pending bucket (#11631)', () => {
    const scene = new Scene();
    scene.appendToBatches([square(1, 0)], device, pipeline, false);
    scene.setQuantizedBatches(true);
    const revision = scene.getPickGeometryRevision();
    assert.equal(requantizeEarlyBatches(scene, () => { throw new Error('device unavailable'); }, pipeline), 0);
    assert.equal(scene.getPickGeometryRevision(), revision);
    assert.equal(quantizedBatches(scene), 0);
    assert.ok(scene.hasPendingBatches());
    assert.equal(requantizeEarlyBatches(scene, () => device, pipeline), 1);
    assert.equal(quantizedBatches(scene), 1);
  });

  it('leaves alone a batch quantization itself kept f32 (#9068), and batches built quantized', () => {
    const scene = new Scene();
    scene.setQuantizedBatches(true);
    // A sliver 0.1 mm wide: the 1 mm lattice collapses it, so the batch stays f32 under `auto`.
    scene.appendToBatches([square(1, 0), square(5, 3, 0.0001)], device, pipeline, false);
    assert.equal(quantizedBatches(scene), 1);
    assert.equal(requantizeEarlyBatches(scene, () => device, pipeline), 0);
  });

  it('waits while a stream or its finalize runs, then rebuilds (a finalize has already taken its pending keys)', () => {
    const scene = new Scene();
    scene.appendToBatches([square(1, 0)], device, pipeline, false);
    scene.appendToBatches([square(2, 3)], device, pipeline, true); // a streaming fragment
    scene.setQuantizedBatches(true);
    const retries: Array<() => void> = [];
    assert.equal(requantizeEarlyBatches(scene, () => device, pipeline, () => true, (retry) => retries.push(retry)), -1);
    assert.equal(scene.hasPendingBatches(), false, 'nothing marked while the stream runs');
    scene.finalizeStreaming(device, pipeline);
    assert.equal(quantizedBatches(scene), 1, 'the streamed bucket is built quantized; the early one is still f32');
    retries.shift()!();
    assert.equal(scene.hasPendingBatches(), false);
    assert.equal(quantizedBatches(scene), 2);
  });

  it('drops a deferred rebuild when the renderer moved on', () => {
    const scene = new Scene();
    scene.appendToBatches([square(1, 0)], device, pipeline, false);
    scene.appendToBatches([square(2, 3)], device, pipeline, true);
    scene.setQuantizedBatches(true);
    let current = true;
    const retries: Array<() => void> = [];
    requantizeEarlyBatches(scene, () => device, pipeline, () => current, (retry) => retries.push(retry));
    scene.finalizeStreaming(device, pipeline);
    current = false;
    retries.shift()!();
    assert.equal(quantizedBatches(scene), 1, 'left as it was');
  });
});
