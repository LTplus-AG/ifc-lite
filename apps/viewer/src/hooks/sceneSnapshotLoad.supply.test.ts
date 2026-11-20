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
import { discardInstancedShards, hasPendingInstancedShards, instancedShardSupplyToken } from '@/store/instancedShardQueue';
import { adoptedSceneOutlivesEmptyGeometry } from '@/components/viewer/sceneSnapshotOwnership';
import { BufferWriter } from '@ifc-lite/cache';
import { writeInstancedShards } from '../../../../packages/cache/src/sections/instanced-shards.js';
import { encodeSceneSnapshot } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { sceneSnapshotKey } from '@/components/viewer/sceneSnapshotOwnership';
import { setGlobalRendererRef } from './useBCF';
import { adoptCachedSceneSnapshot, publishAdoptedSceneMeshes, type AdoptedSceneSnapshot } from './sceneSnapshotLoad';

it('#10888 a discard during a deferred adoption: its shards are never stamped with the newer supply; nothing is registered', async () => {
  const modelId = 'snap-supply';
  const supply = instancedShardSupplyToken(modelId); // adoption begins
  const adopted = { adoption: {}, shards: [new ArrayBuffer(8)], supply, fit: null, firstVisible: Promise.resolve() } as unknown as AdoptedSceneSnapshot;
  discardInstancedShards(modelId); // the model is removed and re-added while the adoption awaits
  const open = { chunks: [], readChunk: async () => [], coordinateInfo: undefined } as never;
  const published = await publishAdoptedSceneMeshes(adopted, open, modelId, {} as never, undefined, undefined, NOOP_LOAD_TRACE, () => {});
  assert.equal(published, null, 'superseded: the caller abandons the adoption');
  let hydrated = 0;
  adoptedSceneOutlivesEmptyGeometry({ isSceneSnapshotHydrating: () => true, hydrateSceneSnapshot: () => { hydrated++; return false; }, removeInstancedTemplatesForModel: () => {} } as never);
  assert.equal(hydrated, 0, 'no pending adoption was registered to settle');
  assert.equal(hasPendingInstancedShards(modelId), false, 'and nothing requeued its shards under the newer supply');
});

it('#10888 a discard and re-add during the adopted chunk decode: the old read registers no adoption and appends no meshes', async () => {
  const modelId = 'snap-decode';
  const supply = instancedShardSupplyToken(modelId);
  const adopted = { adoption: {}, shards: [], supply, fit: null, firstVisible: Promise.resolve() } as unknown as AdoptedSceneSnapshot;
  let resume!: () => void;
  const gate = new Promise<void>((done) => { resume = done; });
  const old = { expressId: 1, positions: new Float32Array(9), normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] };
  const open = { chunks: [0], readChunk: async () => { await gate; return [old]; }, coordinateInfo: undefined } as never;
  const appended: unknown[] = [];
  const publishing = publishAdoptedSceneMeshes(adopted, open, modelId, {} as never, undefined, undefined, NOOP_LOAD_TRACE,
    (_id, meshes) => { appended.push(...meshes); });
  await new Promise((done) => setTimeout(done, 0)); // the chunk decode is awaiting
  discardInstancedShards(modelId); // removed; a replacement load of the same id begins
  resume(); // the OLD read resolves
  assert.equal(await publishing, null, 'superseded without any isStale callback');
  assert.deepEqual(appended, [], 'no old mesh enters the replacement model');
  let hydrated = 0;
  adoptedSceneOutlivesEmptyGeometry({ isSceneSnapshotHydrating: () => true, hydrateSceneSnapshot: () => { hydrated++; return true; }, removeInstancedTemplatesForModel: () => {} } as never);
  assert.equal(hydrated, 0, 'and no old adoption is registered for it');
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
