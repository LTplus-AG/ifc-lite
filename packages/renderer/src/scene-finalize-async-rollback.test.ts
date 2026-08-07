/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import type { BatchedMesh, RenderPipeline } from './types.js';
import type { MeshData } from '@ifc-lite/geometry';

/**
 * `finalizeStreamingAsync` is the time-sliced twin of `finalizeStreamingInner`
 * (see scene-finalize-rollback.test.ts). Unlike the sync path, its chunked GPU
 * rebuild runs across `setTimeout` continuations with no try/catch, so a
 * mid-rebuild GPU failure (e.g. createBuffer OOM) on a LATER chunk:
 *  - is NOT caught by any try/catch around the Promise executor (a throw
 *    inside a setTimeout callback is a distinct macrotask, not part of the
 *    executor's synchronous frame — see the empirical probe in the PR notes),
 *  - leaves `finalizeInProgress` stuck true forever,
 *  - leaves `streamingFragments` wiped (emptied by the synchronous preamble)
 *    with no restoration,
 *  - destroys any live `partialBatchCache` entry before the rebuild could
 *    fail (dropAllPartialCaches ran unconditionally in the preamble), and
 *  - leaves the returned promise permanently unsettled (neither resolved nor
 *    rejected), so callers with no timeout/race have no way to observe failure.
 *
 * These tests seed two buckets and force a yield after the FIRST batch (via
 * budgetMs=0), so the second — the one that throws — runs inside a real
 * setTimeout continuation, not the promise executor's synchronous frame.
 */

function fakeBuffer(): GPUBuffer & { destroyed: number } {
  const buf = {
    size: 0,
    destroyed: 0,
    destroy() { this.destroyed++; },
  };
  return buf as unknown as GPUBuffer & { destroyed: number };
}

function fakeBatch(id: number): BatchedMesh & {
  vertexBuffer: GPUBuffer & { destroyed: number };
  indexBuffer: GPUBuffer & { destroyed: number };
} {
  return {
    id,
    colorKey: `c${id}`,
    vertexBuffer: fakeBuffer(),
    indexBuffer: fakeBuffer(),
    indexCount: 3,
    color: [0, 0, 0, 1],
    expressIds: [],
  } as unknown as BatchedMesh & {
    vertexBuffer: GPUBuffer & { destroyed: number };
    indexBuffer: GPUBuffer & { destroyed: number };
  };
}

function fakeMeshData(color: [number, number, number, number]): MeshData {
  return {
    color,
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    expressId: 1,
  } as unknown as MeshData;
}

const device = {} as GPUDevice;
const pipeline = {} as RenderPipeline;

/**
 * Seeds two buckets with distinct meshData, and stubs bucketBaseKey /
 * resolveActiveBucket so the async preamble's regroup step is deterministic
 * without needing a real spatial-chunking config.
 */
function seedTwoBuckets(scene: Scene): void {
  const mdA = fakeMeshData([1, 0, 0, 1]);
  const mdB = fakeMeshData([0, 1, 0, 1]);
  scene['buckets'].set('keyA', { key: 'keyA', meshData: [mdA], batchedMesh: null, vertexBytes: 0 });
  scene['buckets'].set('keyB', { key: 'keyB', meshData: [mdB], batchedMesh: null, vertexBytes: 0 });
  scene['bucketBaseKey'] = (md: MeshData) => (md === mdA ? 'keyA' : 'keyB');
  scene['resolveActiveBucket'] = (baseKey: string) => baseKey;
}

describe('Scene.finalizeStreamingAsync — GPU-failure rollback', () => {
  it('rejects the promise when a LATER chunk throws inside a setTimeout continuation', async () => {
    const scene = new Scene();
    const fragment = fakeBatch(1);
    scene['streamingFragments'] = [fragment];
    scene['batchedMeshes'] = [];
    seedTwoBuckets(scene);

    let calls = 0;
    scene['createBatchedMesh'] = () => {
      calls++;
      if (calls === 1) return fakeBatch(100); // first chunk succeeds
      throw new RangeError('createBuffer failed (GPU OOM)'); // second chunk (later tick) throws
    };

    // budgetMs=0 forces a yield (setTimeout) after every single batch, so the
    // second createBatchedMesh call happens in a genuine later continuation.
    await assert.rejects(
      () => scene.finalizeStreamingAsync(device, pipeline, 0),
      /createBuffer failed/,
    );

    assert.strictEqual(calls, 2, 'the throw must have happened on the second (later-chunk) call');
  });

  it('restores streamingFragments/batchedMeshes and clears finalizeInProgress when a later chunk throws', async () => {
    const scene = new Scene();
    const fragment = fakeBatch(1);
    const oldBatch = fakeBatch(2);
    scene['streamingFragments'] = [fragment];
    scene['batchedMeshes'] = [oldBatch];
    seedTwoBuckets(scene);

    let calls = 0;
    scene['createBatchedMesh'] = () => {
      calls++;
      if (calls === 1) return fakeBatch(100);
      throw new RangeError('createBuffer failed (GPU OOM)');
    };

    await assert.rejects(() => scene.finalizeStreamingAsync(device, pipeline, 0));

    assert.deepStrictEqual(scene['streamingFragments'], [fragment]);
    assert.deepStrictEqual(scene['batchedMeshes'], [oldBatch]);
    assert.strictEqual(scene.isFinalizeInProgress(), false);
    // Nothing that predated the attempt was destroyed.
    assert.strictEqual(fragment.vertexBuffer.destroyed, 0);
    assert.strictEqual(oldBatch.vertexBuffer.destroyed, 0);
  });

  it('keeps cached partial batches alive when a later chunk throws', async () => {
    const scene = new Scene();
    const partial = fakeBatch(9);
    scene['streamingFragments'] = [fakeBatch(1)];
    scene['batchedMeshes'] = [];
    scene['partialBatchCache'].set('src:v1', partial);
    scene['partialBatchCacheKeys'].set('src', 'src:v1');
    seedTwoBuckets(scene);

    let calls = 0;
    scene['createBatchedMesh'] = () => {
      calls++;
      if (calls === 1) return fakeBatch(100);
      throw new RangeError('boom');
    };

    await assert.rejects(() => scene.finalizeStreamingAsync(device, pipeline, 0));

    assert.strictEqual(partial.vertexBuffer.destroyed, 0);
    assert.strictEqual(partial.indexBuffer.destroyed, 0);
    assert.strictEqual(scene['partialBatchCache'].get('src:v1'), partial);
  });

  // Bounding control: a SUCCESSFUL async finalize must still drop partial
  // caches, clear finalizeInProgress, and swap in the new batches. Without
  // this, "never drop/free/swap anything" would also pass the failure tests.
  it('BOUNDING CONTROL: on success, drops partial caches, clears finalizeInProgress, and swaps in new batches', async () => {
    const scene = new Scene();
    const fragment = fakeBatch(1);
    const oldBatch = fakeBatch(2);
    const partial = fakeBatch(9);
    scene['streamingFragments'] = [fragment];
    scene['batchedMeshes'] = [oldBatch];
    scene['partialBatchCache'].set('src:v1', partial);
    scene['partialBatchCacheKeys'].set('src', 'src:v1');
    seedTwoBuckets(scene);

    const created: Array<ReturnType<typeof fakeBatch>> = [];
    scene['createBatchedMesh'] = () => {
      const b = fakeBatch(100 + created.length);
      created.push(b);
      return b;
    };

    await scene.finalizeStreamingAsync(device, pipeline, 0);

    assert.strictEqual(scene.isFinalizeInProgress(), false);
    assert.deepStrictEqual(scene['streamingFragments'], []);
    assert.deepStrictEqual(scene['batchedMeshes'], created);
    // Old drawables freed now that the replacement is live.
    assert.strictEqual(fragment.vertexBuffer.destroyed, 1);
    assert.strictEqual(oldBatch.vertexBuffer.destroyed, 1);
    // Partial cache dropped (colorKeys stale against the new batches).
    assert.strictEqual(partial.vertexBuffer.destroyed, 1);
    assert.strictEqual(scene['partialBatchCache'].size, 0);
    assert.strictEqual(scene['partialBatchCacheKeys'].size, 0);
  });
});
