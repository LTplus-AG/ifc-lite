/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Scene.limitStreamingFragments`: past the budget a streamed mesh joins its
 * bucket without a transient fragment, so finalize uploads it once. Driven
 * through the real streaming append and finalize; only the GPU upload
 * (`createBatchedMesh`) is stubbed, recording whether it built a fragment
 * (no bucket key) or a bucket batch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh } from './types.js';

const device = {} as GPUDevice;
const pipeline = {} as RenderPipeline;
const RED: [number, number, number, number] = [1, 0, 0, 1];

function triangle(expressId: number, x = 0): MeshData {
  return {
    expressId,
    modelIndex: 0,
    color: RED,
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  } as MeshData;
}

function harness() {
  const scene = new Scene();
  scene['cachedMaxBufferSize'] = 256 * 1024 * 1024;
  let nextId = 1;
  const built: Array<{ fragment: boolean; meshes: number }> = [];
  scene['createBatchedMesh'] = (meshes: MeshData[], color: [number, number, number, number], _d: GPUDevice, _p: RenderPipeline, key?: string) => {
    built.push({ fragment: key === undefined, meshes: meshes.length });
    const buffer = { destroy() {} };
    return {
      id: nextId++, colorKey: key ?? 'fragment', color, indexCount: meshes.length * 3,
      vertexBuffer: buffer, indexBuffer: buffer, expressIds: meshes.map((m) => m.expressId),
    } as unknown as BatchedMesh;
  };
  const stream = (meshes: MeshData[]) => scene.appendToBatches(meshes, device, pipeline, true);
  return { scene, built, stream };
}

describe('Scene.limitStreamingFragments', () => {
  it('draws fragments until the budget is spent, then defers meshes to finalize', () => {
    const { scene, built, stream } = harness();
    scene.limitStreamingFragments(3); // one triangle
    stream([triangle(1)]);
    stream([triangle(2, 5)]);
    stream([triangle(3, 10)]);
    assert.deepStrictEqual(built.map((b) => b.fragment), [true], 'only the first append draws a fragment');
    assert.strictEqual(scene.hasStreamingFragments(), true, 'deferred meshes still await finalize');

    scene.finalizeStreaming(device, pipeline);
    const finalized = built.slice(1);
    assert.ok(finalized.length > 0 && finalized.every((b) => !b.fragment));
    assert.strictEqual(finalized.reduce((n, b) => n + b.meshes, 0), 3, 'finalize uploads every streamed mesh');
  });

  it('finalize restores the default so the next stream draws fragments again', async () => {
    const { scene, built, stream } = harness();
    scene.limitStreamingFragments(0);
    stream([triangle(1)]);
    assert.strictEqual(built.length, 0);
    await scene.finalizeStreamingAsync(device, pipeline);
    built.length = 0;
    stream([triangle(2, 5)]);
    assert.deepStrictEqual(built.map((b) => b.fragment), [true]);
  });

  it('ending an ephemeral stream restores the default', () => {
    const { scene, built, stream } = harness();
    scene.setEphemeralStreamingMode(true);
    scene.limitStreamingFragments(0);
    stream([triangle(1)]);
    scene.finishEphemeralStreaming();
    built.length = 0;
    stream([triangle(2, 5)]);
    assert.deepStrictEqual(built.map((b) => b.fragment), [true]);
  });

  it('clear() restores the default', () => {
    const { scene, built, stream } = harness();
    scene.limitStreamingFragments(0);
    scene.clear();
    stream([triangle(1)]);
    assert.deepStrictEqual(built.map((b) => b.fragment), [true]);
  });
});
