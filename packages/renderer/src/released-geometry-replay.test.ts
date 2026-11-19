/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `replayReleasedGeometry` (#10264): released flat geometry streams back into a
 * scene batch by batch, ends released with no CPU pieces kept, keeps each
 * entity's bounds across batches, and stops cleanly when cancelled or
 * superseded (never leaves an ephemeral pass open).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import type { Renderer } from './renderer.js';
import { replayReleasedGeometry } from './released-geometry-replay.js';

Object.assign(globalThis, { GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 } });

function device(): GPUDevice {
  return {
    limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28 },
    createBuffer: ({ size, usage }: GPUBufferDescriptor) => ({ size, usage, bytes: new Uint8Array(size), destroy() {} }),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({ copyBufferToBuffer() {}, finish: () => ({}) }),
    queue: { submit() {}, writeBuffer() {} },
  } as unknown as GPUDevice;
}
const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;

/** A triangle of entity `id` spanning x..x+1 at height z. */
function tri(id: number, x: number, z: number): MeshData {
  return { expressId: id, positions: Float32Array.from([x, 0, z, x + 1, 0, z, x, 1, z]), normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: Uint32Array.from([0, 1, 2]), color: [0.5, 0.5, 0.5, 1] };
}

function host(scene: Scene, gpu: GPUDevice | null) {
  let renders = 0;
  const renderer = { getScene: () => scene, getGPUDevice: () => gpu, getPipeline: () => pipeline, requestRender: () => { renders++; } };
  return { renderer: renderer as unknown as Pick<Renderer, 'getScene' | 'getGPUDevice' | 'getPipeline' | 'requestRender'>, renders: () => renders };
}

async function* batches(...lists: MeshData[][]): AsyncGenerator<readonly MeshData[]> { for (const list of lists) yield list; }

describe('replayReleasedGeometry', () => {
  it('streams batches back, keeps no CPU pieces, and unions entity bounds across batches', async () => {
    const scene = new Scene();
    const gpu = device();
    // Entity 1's pieces arrive in two different batches.
    const result = await replayReleasedGeometry(host(scene, gpu).renderer, batches([tri(1, 0, 0), tri(2, 5, 0)], [tri(1, 2, 3)]));
    assert.deepEqual(result, { status: 'complete', batches: 2, meshes: 3 });
    assert.equal(scene.isGeometryDataReleased(), true, 'finishes released');
    assert.equal(scene.isEphemeralStreaming(), false);
    assert.equal(scene.getMeshDataPieces(1), undefined, 'no CPU pieces retained');
    assert.ok(scene.getBatchedMeshes().length > 0, 'drawn from GPU batches');
    const box = scene.getEntityBoundingBox(1)!;
    assert.deepEqual([box.min.x, box.min.z, box.max.x, box.max.z], [0, 0, 3, 3], 'bounds span both batches');
    assert.ok(scene.getEntityBoundingBox(2), 'every replayed entity keeps a box');
  });

  it('a superseded or cancelled replay still finishes the ephemeral pass and says it is partial', async () => {
    let current = true;
    const scene = new Scene();
    async function* twoThenStale(): AsyncGenerator<readonly MeshData[]> {
      yield [tri(1, 0, 0)];
      current = false; // a newer reload or device change arrives mid-replay
      yield [tri(2, 5, 0)];
    }
    const superseded = await replayReleasedGeometry(host(scene, device()).renderer, twoThenStale(), { isCurrent: () => current });
    assert.deepEqual(superseded, { status: 'superseded', batches: 1, meshes: 1 });
    assert.equal(scene.isEphemeralStreaming(), false, 'never left open');
    assert.equal(scene.getEntityBoundingBox(2), null, 'nothing after the fence');

    const controller = new AbortController();
    controller.abort();
    const cancelled = await replayReleasedGeometry(host(new Scene(), device()).renderer, batches([tri(1, 0, 0)]), { signal: controller.signal });
    assert.equal(cancelled.status, 'cancelled');
  });

  it('a device swap mid-replay supersedes it', async () => {
    const scene = new Scene();
    let gpu: GPUDevice = device();
    const renderer = { getScene: () => scene, getGPUDevice: () => gpu, getPipeline: () => pipeline, requestRender() {} } as unknown as Pick<Renderer, 'getScene' | 'getGPUDevice' | 'getPipeline' | 'requestRender'>;
    async function* swap(): AsyncGenerator<readonly MeshData[]> { yield [tri(1, 0, 0)]; gpu = device(); yield [tri(2, 0, 0)]; }
    assert.equal((await replayReleasedGeometry(renderer, swap())).status, 'superseded');
  });

  for (const change of ['abort', 'device', 'owner'] as const) {
    it(`#10903 a ${change} change after the final yielded batch prevents a complete result`, async () => {
      const scene = new Scene();
      let gpu: GPUDevice = device();
      let current = true;
      const controller = new AbortController();
      const renderer = { getScene: () => scene, getGPUDevice: () => gpu,
        getPipeline: () => pipeline, requestRender() {} };
      async function* source(): AsyncGenerator<readonly MeshData[]> {
        yield [tri(1, 0, 0)];
        // The consumer is awaiting next(); there is no second batch at which
        // its in-loop fence can notice the change.
        await Promise.resolve();
        if (change === 'abort') controller.abort();
        else if (change === 'device') gpu = device();
        else current = false;
      }
      const result = await replayReleasedGeometry(renderer, source(), {
        signal: controller.signal, isCurrent: () => current,
      });
      assert.deepEqual(result, { status: change === 'abort' ? 'cancelled' : 'superseded', batches: 1, meshes: 1 });
      assert.equal(scene.isEphemeralStreaming(), false, 'a partial final result still closes the pass');
      assert.equal(scene.isGeometryDataReleased(), true);
    });
  }

  it('an error mid-stream still closes the pass before rethrowing', async () => {
    const scene = new Scene();
    async function* broken(): AsyncGenerator<readonly MeshData[]> { yield [tri(1, 0, 0)]; throw new Error('backing read failed'); }
    await assert.rejects(replayReleasedGeometry(host(scene, device()).renderer, broken()), /backing read failed/);
    assert.equal(scene.isEphemeralStreaming(), false);
  });

  it('reports a missing device instead of pretending to replay', async () => {
    assert.deepEqual(await replayReleasedGeometry(host(new Scene(), null).renderer, batches([tri(1, 0, 0)])),
      { status: 'unavailable', reason: 'no-device' });
  });
});
