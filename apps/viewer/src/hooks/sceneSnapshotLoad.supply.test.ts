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
import { publishAdoptedSceneMeshes, type AdoptedSceneSnapshot } from './sceneSnapshotLoad';

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
