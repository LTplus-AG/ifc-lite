/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import type { BatchedMesh, RenderPipeline } from './types.js';

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

  it('destroys nothing on the failure path — the restored arrays still point at it', () => {
    const scene = new Scene();
    const fragment = fakeBatch(1);
    const batch = fakeBatch(2);
    scene['streamingFragments'] = [fragment];
    scene['batchedMeshes'] = [batch];
    scene['rebuildPendingBatches'] = () => { throw new Error('boom'); };

    assert.throws(() => scene.finalizeStreaming(device, pipeline));

    // Freeing these would leave the restored arrays pointing at dead buffers.
    assert.strictEqual(fragment.vertexBuffer.destroyed, 0);
    assert.strictEqual(fragment.indexBuffer.destroyed, 0);
    assert.strictEqual(batch.vertexBuffer.destroyed, 0);
    assert.strictEqual(batch.indexBuffer.destroyed, 0);
  });

  it('clears the in-progress flag even when the rebuild throws', () => {
    const scene = new Scene();
    scene['streamingFragments'] = [fakeBatch(1)];
    scene['rebuildPendingBatches'] = () => { throw new Error('boom'); };

    assert.throws(() => scene.finalizeStreaming(device, pipeline));
    // A stuck flag would wedge every settle-sensitive consumer for the session.
    assert.strictEqual(scene.isFinalizeInProgress(), false);
  });

  it('still swaps in the new batches and frees the old ones on success', () => {
    const scene = new Scene();
    const fragment = fakeBatch(1);
    const batch = fakeBatch(2);
    scene['streamingFragments'] = [fragment];
    scene['batchedMeshes'] = [batch];
    scene['rebuildPendingBatches'] = () => { /* succeeds, builds nothing */ };

    scene.finalizeStreaming(device, pipeline);

    assert.deepStrictEqual(scene['streamingFragments'], []);
    assert.deepStrictEqual(scene['batchedMeshes'], []);
    // The rollback must not have suppressed the normal cleanup.
    assert.strictEqual(fragment.vertexBuffer.destroyed, 1);
    assert.strictEqual(batch.vertexBuffer.destroyed, 1);
  });
});
