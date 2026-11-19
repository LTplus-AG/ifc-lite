/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shadowOccluderBatches, type ShadowBatchScene } from './shadow-occluder-batches.js';
import { classifyBatch } from './batch-visibility.js';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh } from './types.js';

function batch(id: number, expressIds: number[], gpuResident?: boolean): BatchedMesh {
  return { id, colorKey: `c${id}`, expressIds, color: [0.5, 0.5, 0.5, 1], gpuResident } as unknown as BatchedMesh;
}

function fakeScene(batches: BatchedMesh[], rebuildsNow = false, standIns = new Map<number, BatchedMesh[]>()) {
  const recorded: number[] = [];   // own GPU buffers drawn
  const requested: number[] = [];  // own GPU buffers wanted back
  const scene: ShadowBatchScene = {
    getBatchedMeshes: () => batches,
    recordBatchDrawn: (b) => { recorded.push(b.id); },
    requestBatchResidency: (b) => { requested.push(b.id); },
    restoreSubsetParentNow: (b) => (rebuildsNow ? batch(b.id + 100, b.expressIds) : null),
    subsetStandIns: (b) => standIns.get(b.id) ?? [],
  };
  return { scene, recorded, requested };
}

const PIPELINE = {} as RenderPipeline;
const DEVICE = {} as GPUDevice;
const under = (hiddenIds?: Set<number>) => (b: BatchedMesh) => classifyBatch(b, hiddenIds, null);

describe('shadow occluder batches under hide/isolate (#2670, #10264 S2)', () => {
  for (const resident of [true, false]) {
    it(`a partly hidden ${resident ? 'resident' : 'GPU-evicted'} batch casts from its own buffers, with no sub-batch`, () => {
      const parent = batch(1, [1, 2], resident ? undefined : false);
      const { scene, recorded, requested } = fakeScene([parent], !resident);
      const out = shadowOccluderBatches(scene, DEVICE, PIPELINE, under(new Set([1])), true);
      assert.deepEqual(out.map((b) => b.id), [resident ? 1 : 101], 'the parent (or its rebuild) casts; the shadow fragment drops entity 1');
      assert.deepEqual(recorded, [resident ? 1 : 101]);
      assert.deepEqual(requested, []);
    });
  }

  it('without the GPU visibility table a partly hidden batch does not cast, rather than cast its hidden entity', () => {
    const { scene, recorded, requested } = fakeScene([batch(1, [1, 2]), batch(2, [3])]);
    const out = shadowOccluderBatches(scene, DEVICE, PIPELINE, under(new Set([1])), false);
    assert.deepEqual(out.map((b) => b.id), [2], 'the fully visible batch still casts');
    assert.deepEqual(recorded, [2]);
    assert.deepEqual(requested, []);
  });

  it('a partly hidden batch without a lane anchor (entries across two 2^24 pages) does not cast', () => {
    const { scene } = fakeScene([batch(1, [1, 0x01000001, 5])]);
    assert.deepEqual(shadowOccluderBatches(scene, DEVICE, PIPELINE, under(new Set([5])), true), []);
  });

  for (const filtered of [true, false]) {
    it(`${filtered ? 'filtered' : 'unfiltered'}: an evicted parent whose subset was on screen casts from its rebuild in this frame (#9050)`, () => {
      const { scene, recorded, requested } = fakeScene([batch(1, [1, 2], false)], true);
      const out = shadowOccluderBatches(scene, DEVICE, PIPELINE, under(filtered ? new Set([7]) : undefined), true);
      assert.deepEqual(out.map((b) => b.id), [101], 'the rebuild casts, not the shell');
      assert.deepEqual(recorded, [101]);
      assert.deepEqual(requested, [], 'nothing left for the queue');
    });
  }

  for (const hidden of [undefined, new Set([7]), new Set([1])]) {
    it(`an evicted parent past the rebuild cap casts from its stand-ins (#9227), hidden ${hidden ? [...hidden] : 'none'}`, () => {
      const subs = [batch(51, [1]), batch(52, [2])];
      const { scene, requested } = fakeScene([batch(1, [1, 2], false)], false, new Map([[1, subs]]));
      const out = shadowOccluderBatches(scene, DEVICE, PIPELINE, under(hidden), true);
      assert.deepEqual(out.map((b) => b.id), [51, 52], 'the stand-ins the colour pass draws cast, not the evicted shell');
      assert.deepEqual(requested, [1], 'the parent still waits for its rebuild');
    });
  }

  it('an evicted parent with no stand-ins still yields only its shell, which casts nothing', () => {
    const { scene } = fakeScene([batch(1, [1, 2], false)]);
    assert.deepEqual(shadowOccluderBatches(scene, DEVICE, PIPELINE, under(), true).map((b) => b.id), [1]);
  });

  it('without a pipeline an evicted whole batch is only queued', () => {
    const { scene, recorded, requested } = fakeScene([batch(1, [1, 2], false)], true);
    const out = shadowOccluderBatches(scene, DEVICE, null, under(), true);
    assert.deepEqual(out.map((b) => b.id), [1]);
    assert.deepEqual(recorded, []);
    assert.deepEqual(requested, [1]);
  });

  it('a fully hidden batch is neither recorded nor requested', () => {
    const { scene, recorded, requested } = fakeScene([batch(1, [1, 2])]);
    assert.equal(shadowOccluderBatches(scene, DEVICE, PIPELINE, under(new Set([1, 2])), true).length, 0);
    assert.deepEqual([...recorded, ...requested], []);
  });
});
