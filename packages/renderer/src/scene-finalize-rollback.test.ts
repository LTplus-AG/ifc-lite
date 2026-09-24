/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh } from './types.js';
import type { MeshData } from '@ifc-lite/geometry';

/**
 * `finalizeStreamingInner` detaches the old drawables (streamingFragments = [],
 * batchedMeshes = []) BEFORE the replacement GPU buffers exist. Callers contain
 * a failed GPU upload to keep the canvas alive, so without a rollback that
 * containment would leave the scene rendering a half-built — often empty —
 * array: a silently blank model instead of a crash.
 *
 * The rebuild itself needs a real GPUDevice, so it is stubbed here; what is
 * under test is the state restoration around it.
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

const device = {} as GPUDevice;
const pipeline = {} as RenderPipeline;

/**
 * A bucket that received streamed meshes (batch id 2, re-grouped by the
 * finalize) next to one from an earlier, already finalized model (batch id 3,
 * left alone). Routing is stubbed to an identity so no real frame is needed.
 */
function seedStreamedAndUntouched(scene: Scene) {
  const batch = fakeBatch(2);
  const untouched = fakeBatch(3);
  const md = { color: [1, 0, 0, 1], positions: new Float32Array(0), indices: new Uint32Array(0), expressId: 1 } as unknown as MeshData;
  scene['buckets'].set('keyU', { key: 'keyU', meshData: [], batchedMesh: untouched, vertexBytes: 0 });
  scene['buckets'].set('keyS', { key: 'keyS', meshData: [md], batchedMesh: batch, vertexBytes: 0 });
  scene['streamedBucketKeys'].add('keyS');
  scene['bucketBaseKey'] = () => 'keyS';
  scene['resolveActiveBucket'] = (baseKey: string) => baseKey;
  return { batch, untouched };
}

describe('Scene.finalizeStreaming — GPU-failure rollback', () => {
  it('restores the previous drawables when the rebuild throws', () => {
    const scene = new Scene();
    const fragment = fakeBatch(1);
    const batch = fakeBatch(2);
    scene['streamingFragments'] = [fragment];
    scene['batchedMeshes'] = [batch];

    // The production failure: createBuffer throws part-way through the rebuild.
    scene['rebuildPendingBatches'] = () => {
      throw new RangeError(
        "Failed to execute 'createBuffer' on 'GPUDevice': createBuffer failed",
      );
    };

    assert.throws(
      () => scene.finalizeStreaming(device, pipeline),
      /createBuffer failed/,
    );

    // Exactly what was on screen before, still on screen.
    assert.deepStrictEqual(scene['streamingFragments'], [fragment]);
    assert.deepStrictEqual(scene['batchedMeshes'], [batch]);
  });

  it('frees the batches the failed attempt created, but nothing that predates it', () => {
    const scene = new Scene();
    const fragment = fakeBatch(1);
    const batch = fakeBatch(2);
    // A cold shell carried through the rebuild: aliased into BOTH the old and
    // the new array. Freeing it would leave the restored array pointing at
    // dead buffers.
    const carriedCold = fakeBatch(3);
    const partiallyBuilt = fakeBatch(4);
    scene['streamingFragments'] = [fragment];
    scene['batchedMeshes'] = [batch, carriedCold];

    // Realistic partial rebuild: some batches land, then createBuffer throws.
    scene['rebuildPendingBatches'] = () => {
      scene['batchedMeshes'].push(carriedCold, partiallyBuilt);
      throw new RangeError("createBuffer failed");
    };

    assert.throws(() => scene.finalizeStreaming(device, pipeline));

    // Created by the doomed attempt and referenced by nothing else → freed.
    assert.strictEqual(partiallyBuilt.vertexBuffer.destroyed, 1);
    assert.strictEqual(partiallyBuilt.indexBuffer.destroyed, 1);
    // Pre-existing drawables (including the aliased cold shell) → untouched.
    assert.strictEqual(carriedCold.vertexBuffer.destroyed, 0);
    assert.strictEqual(fragment.vertexBuffer.destroyed, 0);
    assert.strictEqual(batch.vertexBuffer.destroyed, 0);
    // …and still on screen.
    assert.deepStrictEqual(scene['streamingFragments'], [fragment]);
    assert.deepStrictEqual(scene['batchedMeshes'], [batch, carriedCold]);
  });

  it('keeps cached partial batches alive when the rebuild throws', () => {
    // Partial batches back an active hide/isolate view. Dropping them before
    // the rebuild destroyed their GPU resources, and the rollback cannot bring
    // them back — the view lost its visible subset and had to rebuild it
    // against the device that just failed.
    const scene = new Scene();
    const partial = fakeBatch(9);
    scene['streamingFragments'] = [fakeBatch(1)];
    scene['partialBatchCache'].set('src:v1', partial);
    scene['partialBatchCacheKeys'].set('src', 'src:v1');
    scene['rebuildPendingBatches'] = () => { throw new Error('boom'); };

    assert.throws(() => scene.finalizeStreaming(device, pipeline));

    assert.strictEqual(partial.vertexBuffer.destroyed, 0);
    assert.strictEqual(partial.indexBuffer.destroyed, 0);
    assert.strictEqual(scene['partialBatchCache'].get('src:v1'), partial);
  });

  it('drops the cached partial batches of the replaced batches once the build succeeds, and no others', () => {
    const scene = new Scene();
    const streamed = seedStreamedAndUntouched(scene);
    const partialStreamed = fakeBatch(9);
    const partialUntouched = fakeBatch(10);
    scene['streamingFragments'] = [fakeBatch(1)];
    // Partial caches are keyed by their SOURCE batch, `${colorKey}:${id}`.
    scene['partialBatchCache'].set('c2:2:v1', partialStreamed);
    scene['partialBatchCacheKeys'].set('c2:2', 'c2:2:v1');
    scene['partialBatchCache'].set('c3:3:v1', partialUntouched);
    scene['partialBatchCacheKeys'].set('c3:3', 'c3:3:v1');
    scene['rebuildPendingBatches'] = () => { /* succeeds */ };

    scene.finalizeStreaming(device, pipeline);

    // The streamed bucket's batch is gone, so its partial is stale...
    assert.strictEqual(streamed.batch.id, 2);
    assert.strictEqual(partialStreamed.vertexBuffer.destroyed, 1);
    // ...while the untouched model's batch and its partial are still valid (#5358).
    assert.strictEqual(partialUntouched.vertexBuffer.destroyed, 0);
    assert.strictEqual(scene['partialBatchCache'].get('c3:3:v1'), partialUntouched);
  });

  it('clears the in-progress flag even when the rebuild throws', () => {
    const scene = new Scene();
    scene['streamingFragments'] = [fakeBatch(1)];
    scene['rebuildPendingBatches'] = () => { throw new Error('boom'); };

    assert.throws(() => scene.finalizeStreaming(device, pipeline));
    // A stuck flag would wedge every settle-sensitive consumer for the session.
    assert.strictEqual(scene.isFinalizeInProgress(), false);
  });

  it('keeps the replacement and frees the replaced drawables on success, and only those', () => {
    const scene = new Scene();
    const fragment = fakeBatch(1);
    const { batch, untouched } = seedStreamedAndUntouched(scene);
    const replacement = fakeBatch(4);
    scene['streamingFragments'] = [fragment];
    scene['batchedMeshes'] = [untouched, batch];
    scene['rebuildPendingBatches'] = () => {
      scene['batchedMeshes'].push(untouched, replacement);
    };

    scene.finalizeStreaming(device, pipeline);

    // The replacement is installed and must NOT be caught by any cleanup.
    assert.deepStrictEqual(scene['batchedMeshes'], [untouched, replacement]);
    assert.strictEqual(replacement.vertexBuffer.destroyed, 0);
    assert.strictEqual(replacement.indexBuffer.destroyed, 0);
    assert.deepStrictEqual(scene['streamingFragments'], []);
    // The rollback must not have suppressed the normal cleanup of the old ones.
    assert.strictEqual(fragment.vertexBuffer.destroyed, 1);
    assert.strictEqual(fragment.indexBuffer.destroyed, 1);
    assert.strictEqual(batch.vertexBuffer.destroyed, 1);
    assert.strictEqual(batch.indexBuffer.destroyed, 1);
    // Another model's batch is not rebuilt, so it is not freed (#5358).
    assert.strictEqual(untouched.vertexBuffer.destroyed, 0);
  });
});
