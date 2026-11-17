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

function fakeScene(batches: BatchedMesh[], subsetIndexCount: number, rebuildsNow = false, standIns = new Map<number, BatchedMesh[]>()) {
  const recorded: number[] = [];          // own GPU buffers drawn
  const subsetRecorded: number[] = [];    // drawn only as a subset of its pieces
  const requested: number[] = [];         // own GPU buffers wanted back
  const piecesRequested: number[] = [];   // only CPU pieces wanted back
  const offScreen: boolean[] = [];        // subset recorded as a shadow caster only
  const scene: ShadowBatchScene = {
    getBatchedMeshes: () => batches,
    recordBatchDrawn: (b) => { recorded.push(b.id); },
    recordBatchSubsetDrawn: (b, onScreen) => { subsetRecorded.push(b.id); offScreen.push(onScreen === false); },
    requestBatchResidency: (b) => { requested.push(b.id); },
    requestBatchPieces: (b) => { piecesRequested.push(b.id); },
    restoreSubsetParentNow: (b) => (rebuildsNow ? batch(b.id + 100, b.expressIds) : null),
    getOrCreatePartialBatch: () => (subsetIndexCount > 0 ? ({ id: 999, indexCount: subsetIndexCount } as unknown as BatchedMesh) : undefined),
    subsetStandIns: (b) => standIns.get(b.id) ?? [],
  };
  return { scene, recorded, subsetRecorded, requested, piecesRequested, offScreen };
}

const PIPELINE = {} as RenderPipeline;
const DEVICE = {} as GPUDevice;

describe('shadow occluder residency (#9034, #9050)', () => {
  for (const resident of [true, false]) {
    it(`a partially visible ${resident ? 'resident' : 'GPU-evicted'} parent whose subset casts keeps its pieces, not its own buffers`, () => {
      const parent = batch(1, [1, 2], resident ? undefined : false);
      const { scene, recorded, subsetRecorded, requested, piecesRequested, offScreen } = fakeScene([parent], 3);
      const out = shadowOccluderBatches(scene, { hiddenIds: new Set([1]) }, DEVICE, true, PIPELINE, 0);
      assert.deepEqual(out.map((b) => b.id), [999]);
      assert.deepEqual(subsetRecorded, [1]);
      assert.deepEqual(offScreen, [true], 'a caster may be off screen: it does not earn an un-isolate rebuild');
      assert.deepEqual(recorded, [], 'the subset never reads the parent buffers');
      assert.deepEqual(requested, [], 'no parent GPU rebuild for a subset');
      assert.deepEqual(piecesRequested, resident ? [] : [1], 'an evicted parent is asked for its pieces');
    });
  }

  for (const resident of [true, false]) {
    it(`a partial ${resident ? 'resident' : 'GPU-evicted'} parent whose subset comes back empty is not recorded`, () => {
      const parent = batch(1, [1, 2], resident ? undefined : false);
      const { scene, recorded, subsetRecorded, requested, piecesRequested } = fakeScene([parent], 0);
      const out = shadowOccluderBatches(scene, { hiddenIds: new Set([1]) }, DEVICE, true, PIPELINE, 0);
      assert.equal(out.length, 0);
      assert.deepEqual([...recorded, ...subsetRecorded], [], 'nothing cast, so nothing drawn');
      assert.deepEqual(requested, []);
      assert.deepEqual(piecesRequested, resident ? [] : [1]);
    });
  }

  for (const resident of [true, false]) {
    it(`a fully visible ${resident ? 'resident' : 'GPU-evicted'} batch draws from, or asks back, its own buffers`, () => {
      const { scene, recorded, subsetRecorded, requested, piecesRequested } = fakeScene([batch(1, [1, 2], resident ? undefined : false)], 3);
      shadowOccluderBatches(scene, { hiddenIds: new Set([7]) }, DEVICE, true, PIPELINE, 0);
      assert.deepEqual(recorded, resident ? [1] : []);
      assert.deepEqual(requested, resident ? [] : [1]);
      assert.deepEqual([...subsetRecorded, ...piecesRequested], []);
    });
  }

  for (const filtered of [true, false]) {
    it(`${filtered ? 'filtered' : 'unfiltered'}: an evicted parent whose subset was on screen casts from its rebuild in this frame (#9050)`, () => {
      const { scene, recorded, requested } = fakeScene([batch(1, [1, 2], false)], 3, true);
      const out = shadowOccluderBatches(scene, filtered ? { hiddenIds: new Set([7]) } : {}, DEVICE, filtered, PIPELINE, 0);
      assert.deepEqual(out.map((b) => b.id), [101], 'the rebuild casts, not the shell');
      assert.deepEqual(recorded, [101]);
      assert.deepEqual(requested, [], 'nothing left for the queue');
    });
  }

  for (const filtered of [true, false]) {
    it(`${filtered ? 'filtered' : 'unfiltered'}: an evicted parent past the rebuild cap casts from its stand-ins (#9227)`, () => {
      const subs = [batch(51, [1]), batch(52, [2])];
      const { scene, requested } = fakeScene([batch(1, [1, 2], false)], 3, false, new Map([[1, subs]]));
      const out = shadowOccluderBatches(scene, filtered ? { hiddenIds: new Set([7]) } : {}, DEVICE, filtered, PIPELINE, 0);
      assert.deepEqual(out.map((b) => b.id), [51, 52], 'the stand-ins the colour pass draws cast, not the evicted shell');
      assert.deepEqual(requested, [1], 'the parent still waits for its rebuild');
    });
  }

  it('an evicted parent with no stand-ins still yields only its shell, which casts nothing', () => {
    const { scene } = fakeScene([batch(1, [1, 2], false)], 3, false);
    assert.deepEqual(shadowOccluderBatches(scene, {}, DEVICE, false, PIPELINE, 0).map((b) => b.id), [1]);
  });

  it('without a pipeline an evicted whole batch is only queued', () => {
    const { scene, recorded, requested } = fakeScene([batch(1, [1, 2], false)], 3, true);
    const out = shadowOccluderBatches(scene, {}, DEVICE, false, null, 0);
    assert.deepEqual(out.map((b) => b.id), [1]);
    assert.deepEqual(recorded, []);
    assert.deepEqual(requested, [1]);
  });

  it('a fully hidden batch is neither recorded nor requested', () => {
    const { scene, recorded, subsetRecorded, requested, piecesRequested } = fakeScene([batch(1, [1, 2])], 3);
    assert.equal(shadowOccluderBatches(scene, { hiddenIds: new Set([1, 2]) }, DEVICE, true, PIPELINE, 0).length, 0);
    assert.deepEqual([...recorded, ...subsetRecorded, ...requested, ...piecesRequested], []);
  });
});
