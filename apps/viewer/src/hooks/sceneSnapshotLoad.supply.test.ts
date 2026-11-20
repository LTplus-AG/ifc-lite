/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10888: an adopted scene snapshot's shards belong to the model's shard supply
 * as it was when adoption BEGAN. A model-scoped discard while the adoption is
 * deferred (its awaits) supersedes them: a later refusal must not requeue them
 * under the newer supply, whatever the caller's optional staleness check says.
 */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { NOOP_LOAD_TRACE } from '@ifc-lite/load-trace';
import { discardInstancedShards, hasPendingInstancedShards, instancedShardDrops, instancedShardSupplyToken } from '@/store/instancedShardQueue';
import { adoptedSceneOutlivesEmptyGeometry } from '@/components/viewer/sceneSnapshotOwnership';
import { BufferWriter } from '@ifc-lite/cache';
import { writeInstancedShards } from '../../../../packages/cache/src/sections/instanced-shards.js';
import { encodeSceneSnapshot } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { sceneSnapshotKey } from '@/components/viewer/sceneSnapshotOwnership';
import { setGlobalRendererRef } from './useBCF';
import { adoptCachedSceneSnapshot, publishAdoptedSceneMeshes, type AdoptedSceneSnapshot } from './sceneSnapshotLoad';

it('#10888 a discard during a deferred adoption: its shards are refused on requeue, never stamped with the newer supply', async () => {
  const modelId = 'snap-supply';
  const supply = instancedShardSupplyToken(modelId); // adoption begins
  const adopted = { adoption: {}, shards: [new ArrayBuffer(8)], supply, fit: null, firstVisible: Promise.resolve() } as unknown as AdoptedSceneSnapshot;
  discardInstancedShards(modelId); // the model is removed and re-added while the adoption awaits
  const superseded = instancedShardDrops().superseded;
  const open = { chunks: [], readChunk: async () => [], coordinateInfo: undefined } as never;
  await publishAdoptedSceneMeshes(adopted, open, modelId, {} as never, undefined, undefined, NOOP_LOAD_TRACE, () => {});
  // The scene refuses the snapshot: its shards are handed to the ordinary drain.
  adoptedSceneOutlivesEmptyGeometry({ isSceneSnapshotHydrating: () => true, hydrateSceneSnapshot: () => false, removeInstancedTemplatesForModel: () => {} } as never);
  assert.equal(hasPendingInstancedShards(modelId), false, 'the superseded shards never reach the queue');
  assert.equal(instancedShardDrops().superseded, superseded + 1, 'they are refused as superseded');
});

/** IFNS v1: one template triangle, one occurrence of `entityId`. */
function shardBytes(entityId: number): ArrayBuffer {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0], normals = [0, 0, 1, 0, 0, 1, 0, 0, 1], indices = [0, 1, 2];
  const dataOffset = 32 + 48 + 88;
  const buffer = new ArrayBuffer(dataOffset + (positions.length + normals.length + indices.length) * 4);
  const view = new DataView(buffer);
  [0x4946_4e53, 1, 1, 1, positions.length, normals.length, indices.length, 0].forEach((w, i) => view.setUint32(i * 4, w, true));
  [0, 9, 0, 9, 0, 3].forEach((w, i) => view.setUint32(32 + i * 4, w, true));
  view.setUint32(84, entityId, true);
  [0.5, 0.5, 0.5, 1].forEach((c, i) => view.setFloat32(88 + i * 4, c, true));
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1].forEach((m, i) => view.setFloat32(104 + i * 4, m, true));
  let cursor = dataOffset;
  for (const v of positions) { view.setFloat32(cursor, v, true); cursor += 4; }
  for (const v of normals) { view.setFloat32(cursor, v, true); cursor += 4; }
  for (const v of indices) { view.setUint32(cursor, v, true); cursor += 4; }
  return buffer;
}

for (const discard of [false, true]) {
  it(`#10888 a deferred adoption ${discard ? 'whose model is discarded while it reads uploads NO shard (isStale absent)' : 'with its supply intact uploads its shards'}`, async () => {
    const modelId = `snap-direct-${discard}`;
    const writer = new BufferWriter();
    writeInstancedShards(writer, [shardBytes(77)]);
    const entry = new Blob([writer.build()]);
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
    const snapshot = await encodeSceneSnapshot({ policy: 'p', pieceCount: 0, nextSplitId: 0, sharedFrameOrigins: [], activeBuckets: [], batches: [],
      hostData: { fitBounds: bounds, sceneBounds: bounds, shards: { offset: 0, size: entry.size } } }).arrayBuffer();
    let resume!: () => void;
    const gate = new Promise<void>((done) => { resume = done; });
    let uploaded = 0;
    const scene = { sceneSnapshotPolicy: () => 'p', adoptSceneSnapshot: () => ({}), addInstancedShard: () => { uploaded++; } };
    const renderer = { getGPUDevice: () => ({}), getPipeline: () => ({}), getScene: () => scene, getCamera: () => ({ reset() {}, fitBoundsAdaptive() {}, setSceneBounds() {}, setOrbitAnchorBounds() {} }),
      getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }), clearCaches() {}, requestRender() {} };
    setGlobalRendererRef({ current: renderer as never });
    Object.assign(globalThis.navigator ?? Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true }).navigator, { gpu: {} });
    const s = useViewerStore.getState();
    const cacheResult = { sceneSnapshot: { arrayBuffer: async () => { await gate; return snapshot; } },
      sceneSnapshotKey: sceneSnapshotKey('p', s.typeViewMode, s.typeVisibility, s.structuralViewMode), buffer: entry };
    const adopting = adoptCachedSceneSnapshot(cacheResult as never, modelId, undefined, NOOP_LOAD_TRACE);
    await new Promise((done) => setTimeout(done, 0)); // the adoption is reading its snapshot
    if (discard) discardInstancedShards(modelId); // the model is removed while it reads
    resume();
    const adopted = await adopting;
    if (discard) {
      assert.equal(adopted, null, 'the superseded snapshot is not adopted');
      assert.equal(uploaded, 0, 'no shard of the old supply reaches the GPU');
    } else {
      assert.ok(adopted);
      assert.equal(uploaded, 1, 'the current supply uploads directly, as before');
    }
  });
}
