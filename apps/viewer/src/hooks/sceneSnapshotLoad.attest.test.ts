/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createStore } from 'zustand/vanilla';
import type { MeshData } from '@ifc-lite/geometry';
import { instancedShardSupplyToken } from '@/store/instancedShardQueue';
import { StoreGeometryBackingTap, type TapState } from '@/lib/geometry-backing/store-backing-tap';
import { attestAdoptedShards, uploadSnapshotShards } from './sceneSnapshotLoad';

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
const mesh: MeshData = { expressId: 1, positions: new Float32Array(9), normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] };

for (const failOne of [true, false]) {
  it(`#10937 a committed snapshot whose upload ${failOne ? 'FAILED for one shard is never attested complete' : 'landed every shard is attested and backed'}`, async () => {
    const modelId = `snap-${failOne}`;
    const store = createStore<TapState>(() => ({ models: new Map([[modelId, { geometryResult: { meshes: [mesh] }, idOffset: 0 }]]), geometryContentVersion: 0 }));
    const tap = await StoreGeometryBackingTap.start(store, { database: { name: `snapshot-attest-${process.pid}-${failOne}`, locks: null } });
    try {
      let calls = 0;
      const scene = { addInstancedShard: () => { if (failOne && ++calls === 2) throw new Error('device lost'); } };
      const token = instancedShardSupplyToken(modelId);
      const shards = [shardBytes(77), shardBytes(78)];
      const shardsUploaded = uploadSnapshotShards(scene as never, {} as GPUDevice, modelId, shards);
      assert.equal(shardsUploaded, !failOne);
      attestAdoptedShards(modelId, { shards, shardsUploaded }, token); // hydrateSceneSnapshot committed
      const [status] = await tap.seal();
      assert.equal(status.complete, !failOne, failOne ? 'the scene lacks occurrence 78: the backing must not claim it' : status.error ?? 'incomplete');
      if (!failOne) assert.equal(status.shards, 2);
    } finally { await tap.stop(); }
  });
}
