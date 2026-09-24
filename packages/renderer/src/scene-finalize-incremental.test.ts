/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5358: a streaming finalize rebuilds only what was streamed since the last
 * finalize. It used to dissolve and re-upload every bucket in the scene, so
 * each federated add re-merged the whole federation (O(N^2) over N models)
 * and briefly held two GPU copies of all of it.
 *
 * Driven through the real `appendToBatches` streaming path and the real
 * re-group / rebuild; only the GPU upload (`createBatchedMesh`) is stubbed,
 * and it records which bucket keys it was asked to build.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh } from './types.js';

type FakeBatch = BatchedMesh & { destroyed: number; meshCount: number };

const device = {} as GPUDevice;
const pipeline = {} as RenderPipeline;

function triangle(expressId: number, modelIndex: number, color: [number, number, number, number], x = 0): MeshData {
  return {
    expressId,
    modelIndex,
    color,
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  } as MeshData;
}

function harness() {
  const scene = new Scene();
  scene['cachedMaxBufferSize'] = 256 * 1024 * 1024;
  let nextId = 1;
  const built: Array<{ key: string | undefined; batch: FakeBatch }> = [];
  scene['createBatchedMesh'] = (meshes: MeshData[], color: [number, number, number, number], _d: GPUDevice, _p: RenderPipeline, key?: string) => {
    const buffer = () => ({ destroy() { batch.destroyed++; } });
    const batch = {
      id: nextId++,
      colorKey: key ?? `fragment`,
      color,
      indexCount: meshes.length * 3,
      vertexBuffer: buffer(),
      indexBuffer: buffer(),
      expressIds: meshes.map((m) => m.expressId),
      destroyed: 0,
      meshCount: meshes.length,
    } as unknown as FakeBatch;
    built.push({ key, batch });
    return batch;
  };
  const stream = (meshes: MeshData[]) => scene.appendToBatches(meshes, device, pipeline, true);
  return { scene, built, stream };
}

const RED: [number, number, number, number] = [1, 0, 0, 1];
const GREEN: [number, number, number, number] = [0, 1, 0, 1];

describe('Scene streaming finalize is incremental (#5358)', () => {
  it('rebuilds only the new model on a federated add and keeps the earlier model\'s batches', () => {
    const { scene, built, stream } = harness();
    stream([triangle(1, 0, RED), triangle(2, 0, GREEN, 5)]);
    scene.finalizeStreaming(device, pipeline);
    const model0Batches = scene.getBatchedMeshes().slice() as FakeBatch[];
    assert.strictEqual(model0Batches.length, 2);

    built.length = 0;
    stream([triangle(1, 1, RED), triangle(2, 1, GREEN, 5)]);
    const fragmentsBuilt = built.length;
    scene.finalizeStreaming(device, pipeline);

    const finalizeBuilt = built.slice(fragmentsBuilt);
    assert.deepStrictEqual(
      finalizeBuilt.map((b) => b.key).sort(),
      [...new Set(finalizeBuilt.map((b) => b.key))].sort(),
      'each bucket is built once',
    );
    assert.strictEqual(finalizeBuilt.length, 2, 'only the two model-1 buckets are built');
    for (const { key } of finalizeBuilt) assert.ok(key?.startsWith('model1~'), `rebuilt ${key}, which is not model 1`);

    // Model 0's batches are the same objects, still live and still drawn.
    const drawn = scene.getBatchedMeshes();
    for (const batch of model0Batches) {
      assert.strictEqual(batch.destroyed, 0, `model 0 batch ${batch.colorKey} was freed`);
      assert.ok(drawn.includes(batch), `model 0 batch ${batch.colorKey} is no longer drawn`);
    }
    assert.strictEqual(drawn.length, 4);
  });

  it('async finalize is incremental too', async () => {
    const { scene, built, stream } = harness();
    stream([triangle(1, 0, RED)]);
    await scene.finalizeStreamingAsync(device, pipeline);
    const [model0] = scene.getBatchedMeshes() as FakeBatch[];

    built.length = 0;
    stream([triangle(1, 1, RED)]);
    const fragmentsBuilt = built.length;
    await scene.finalizeStreamingAsync(device, pipeline);

    const finalizeBuilt = built.slice(fragmentsBuilt);
    assert.deepStrictEqual(finalizeBuilt.map((b) => b.key), ['model1~' + model0.colorKey]);
    assert.strictEqual(model0.destroyed, 0);
    assert.deepStrictEqual(scene.getBatchedMeshes(), [model0, finalizeBuilt[0].batch]);
    // Every streaming fragment is freed once the replacement is live.
    for (const { batch } of built.slice(0, fragmentsBuilt)) assert.ok(batch.destroyed > 0);
  });

  it('still re-groups a streamed mesh whose colour changed in place while streaming', () => {
    const { scene, built, stream } = harness();
    stream([triangle(1, 0, RED)]);
    // Deferred style colour, applied in place to the retained mesh mid-stream.
    const [stored] = [...scene['buckets'].values()][0].meshData;
    stored.color = GREEN;
    scene.finalizeStreaming(device, pipeline);

    const [batch] = scene.getBatchedMeshes() as FakeBatch[];
    assert.deepStrictEqual(Array.from(batch.color), GREEN);
    assert.strictEqual(built.at(-1)?.batch, batch);
  });

  it('merges a streamed mesh into an existing bucket of the same model and colour', () => {
    const { scene, stream } = harness();
    stream([triangle(1, 0, RED)]);
    scene.finalizeStreaming(device, pipeline);
    const [first] = scene.getBatchedMeshes() as FakeBatch[];

    stream([triangle(2, 0, RED, 5)]);
    scene.finalizeStreaming(device, pipeline);

    const batches = scene.getBatchedMeshes() as FakeBatch[];
    assert.strictEqual(batches.length, 1, 'one colour, one model, one bucket');
    assert.strictEqual(batches[0].meshCount, 2);
    assert.strictEqual(first.destroyed > 0, true, 'the replaced batch is freed');
  });

  it('keeps a mesh streamed in while a failing async finalize was mid-way', async () => {
    // Review finding on #5453: the rollback used to REPLACE the streamed-key
    // set and the fragment list with their pre-finalize snapshots, dropping
    // anything that streamed in between two time-sliced chunks.
    const { scene, built, stream } = harness();
    stream([triangle(1, 0, RED), triangle(2, 0, GREEN, 5)]);
    const create = scene['createBatchedMesh'];
    let failSecondBucketBuild = true;
    let bucketBuilds = 0;
    scene['createBatchedMesh'] = (meshes: MeshData[], color: [number, number, number, number], d: GPUDevice, p: RenderPipeline, key?: string) => {
      if (key !== undefined && failSecondBucketBuild && ++bucketBuilds === 2) throw new RangeError('createBuffer failed');
      return create(meshes, color, d, p, key);
    };

    // budgetMs 0: the first bucket builds now, the second in a later task.
    const finalizing = scene.finalizeStreamingAsync(device, pipeline, 0);
    stream([triangle(3, 1, RED)]);
    await assert.rejects(finalizing, /createBuffer failed/);

    const streamed = [...scene['streamedBucketKeys']];
    assert.ok(streamed.some((key) => key.startsWith('model1~')), `model 1's key was lost: ${streamed}`);
    assert.strictEqual(streamed.length, 3, 'both model-0 keys and the model-1 key are pending a finalize');
    const fragments = scene['streamingFragments'] as FakeBatch[];
    assert.strictEqual(fragments.length, built.filter((b) => b.key === undefined).length, 'every fragment is still tracked');

    failSecondBucketBuild = false;
    await scene.finalizeStreamingAsync(device, pipeline);
    const keys = scene.getBatchedMeshes().map((b) => b.colorKey).sort();
    assert.strictEqual(keys.length, 3);
    assert.ok(keys.some((key) => key.startsWith('model1~')), `model 1 was never built: ${keys}`);
    for (const fragment of fragments) assert.ok(fragment.destroyed > 0, 'fragment freed once replaced');
  });

  it('restores the bucket map when the rebuild fails, so a retry rebuilds the same set', () => {
    const { scene, built, stream } = harness();
    stream([triangle(1, 0, RED)]);
    scene.finalizeStreaming(device, pipeline);
    const [model0] = scene.getBatchedMeshes() as FakeBatch[];

    stream([triangle(1, 1, RED)]);
    const create = scene['createBatchedMesh'];
    scene['createBatchedMesh'] = () => { throw new RangeError('createBuffer failed'); };
    assert.throws(() => scene.finalizeStreaming(device, pipeline), /createBuffer failed/);
    scene['createBatchedMesh'] = create;

    assert.strictEqual(model0.destroyed, 0);
    assert.ok(scene.hasStreamingFragments(), 'the fragments are back on screen');

    const before = built.length;
    scene.finalizeStreaming(device, pipeline);
    assert.deepStrictEqual(built.slice(before).map((b) => b.key), ['model1~' + model0.colorKey]);
    assert.strictEqual(scene.getBatchedMeshes().length, 2);
  });
});
