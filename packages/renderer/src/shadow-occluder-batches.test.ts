/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shadowOccluderBatches, type ShadowBatchScene } from './shadow-occluder-batches.js';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh } from './types.js';

function batch(id: number, expressIds: number[], gpuResident?: boolean): BatchedMesh {
  return { id, colorKey: `c${id}`, expressIds, color: [0.5, 0.5, 0.5, 1], gpuResident } as unknown as BatchedMesh;
}

function fakeScene(batches: BatchedMesh[], subsetIndexCount: number) {
  const recorded: number[] = [];
  const requested: number[] = [];
  const scene: ShadowBatchScene = {
    getBatchedMeshes: () => batches,
    recordBatchDrawn: (b) => { recorded.push(b.id); },
    requestBatchResidency: (b) => { requested.push(b.id); },
    getOrCreatePartialBatch: () => (subsetIndexCount > 0 ? ({ id: 999, indexCount: subsetIndexCount } as unknown as BatchedMesh) : undefined),
  };
  return { scene, recorded, requested };
}

const PIPELINE = {} as RenderPipeline;
const DEVICE = {} as GPUDevice;

describe('shadow occluder residency (#9034)', () => {
  for (const resident of [true, false]) {
    it(`a partially visible ${resident ? 'resident' : 'GPU-evicted'} parent whose subset casts is recorded as drawn`, () => {
      const parent = batch(1, [1, 2], resident ? undefined : false);
      const { scene, recorded, requested } = fakeScene([parent], 3);
      const out = shadowOccluderBatches(scene, { hiddenIds: new Set([1]) }, DEVICE, true, PIPELINE, 0);
      assert.deepEqual(out.map((b) => b.id), [999]);
      assert.deepEqual(recorded, [1]);
      assert.deepEqual(requested, resident ? [] : [1], 'an evicted parent is still asked back');
    });
  }

  it('a partial parent whose subset comes back empty (cold) is not recorded', () => {
    const parent = batch(1, [1, 2], false);
    const { scene, recorded, requested } = fakeScene([parent], 0);
    const out = shadowOccluderBatches(scene, { hiddenIds: new Set([1]) }, DEVICE, true, PIPELINE, 0);
    assert.equal(out.length, 0);
    assert.deepEqual(recorded, []);
    assert.deepEqual(requested, [1]);
  });

  it('a fully hidden batch is neither recorded nor requested', () => {
    const { scene, recorded, requested } = fakeScene([batch(1, [1, 2])], 3);
    assert.equal(shadowOccluderBatches(scene, { hiddenIds: new Set([1, 2]) }, DEVICE, true, PIPELINE, 0).length, 0);
    assert.deepEqual(recorded, []);
    assert.deepEqual(requested, []);
  });
});
