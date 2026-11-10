/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Queued instanced shards belong to the model that produced them (#9628 review).
 *
 * The drain runs a task after the enqueue, so a model can leave in between. A
 * shard of a removed model used to be taken anyway and, with its owner gone
 * from both maps, uploaded under index 0 and offset 0: the surviving primary's
 * ids. Removal and full clears now withdraw the model's queued shards; a
 * shard whose owner the drain's maps do not list waits only while the store
 * lists it, and is otherwise dropped and counted; a superseded load's shards
 * are refused on arrival. Nothing is attributed to model 0.
 *
 * Real store actions and index allocator, the actual drain hook, hand-built
 * IFNS bytes; the renderer records uploads.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef, useState } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { DecodedInstancedShard } from '@ifc-lite/geometry';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { buildShardBytes } from '@/test/instanced-shard-fixture.js';
import { discardInstancedShards, enqueueInstancedShards, hasPendingInstancedShards, instancedShardDrops, instancedShardGeneration } from '@/store/instancedShardQueue';
import { useInstancedShardDrain } from './useInstancedShardDrain.js';

let uploads: Array<{ id: number; index: number | undefined }> = [];
const renderer = {
  getGPUDevice: () => ({}),
  getScene: () => ({
    addInstancedShard: (_device: unknown, shard: DecodedInstancedShard, index?: number) => {
      for (const instance of shard.instances) uploads.push({ id: instance.entityId, index });
    },
    getInstancedModelIndices: () => [],
  }),
  requestRender: () => {},
} as unknown as Renderer;

/** The Viewport's derivation: both maps come from the store's `models`. */
function Viewport() {
  const models = useViewerStore((s) => s.models);
  useInstancedShardDrain({
    rendererRef: useRef(renderer), isInitialized: true, gpuRecoveryEpoch: 0, geometryKernel: 'exact', geometry: null,
    modelIdToIndex: modelIndices(models),
    modelIdToOffset: new Map([...models].map(([id, model]) => [id, model.idOffset ?? 0])),
    cameraFittedRef: useRef(false), cameraSnapshotRef: useRef(null),
    geometryBoundsRef: useRef({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }),
    finalBoundsRefittedRef: useRef(false), lastFitPolicyKindRef: useRef(null), lastGeometryRef: useRef(null),
  });
  return null;
}

const drainTask = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

beforeEach(() => {
  uploads = [];
  useViewerStore.getState().clearAllModels();
  const state = useViewerStore.getState();
  const primaryOffset = state.registerModelOffset('primary', 100);
  const secondOffset = state.registerModelOffset('second', 100);
  useViewerStore.setState(fixtureModels(
    fixtureModel('primary', { idOffset: primaryOffset }),
    fixtureModel('second', { idOffset: secondOffset }),
  ));
});
afterEach(() => { cleanup(); discardInstancedShards(); useViewerStore.getState().clearAllModels(); });

it('drops a removed model\'s queued shards instead of uploading them as the primary\'s', async () => {
  render(<Viewport />);
  act(() => enqueueInstancedShards('second', [buildShardBytes(31)], instancedShardGeneration()));
  act(() => useViewerStore.getState().removeModel('second'));
  await drainTask();
  assert.deepEqual(uploads, [], 'a removed model\'s shard reaches no surviving model');
  assert.equal(hasPendingInstancedShards(), false, 'removal withdraws the bytes');
});

it('drops every queued shard when all models are cleared', async () => {
  render(<Viewport />);
  act(() => {
    enqueueInstancedShards('primary', [buildShardBytes(31)], instancedShardGeneration());
    enqueueInstancedShards('second', [buildShardBytes(32)], instancedShardGeneration());
  });
  act(() => useViewerStore.getState().clearAllModels());
  await drainTask();
  assert.deepEqual(uploads, []);
  assert.equal(hasPendingInstancedShards(), false);
});

it('keeps the surviving model\'s shards when another model is removed', async () => {
  render(<Viewport />);
  const offset = useViewerStore.getState().models.get('second')!.idOffset;
  const index = modelIndices(useViewerStore.getState().models).get('second');
  act(() => {
    enqueueInstancedShards('primary', [buildShardBytes(31)], instancedShardGeneration());
    enqueueInstancedShards('second', [buildShardBytes(32)], instancedShardGeneration());
  });
  act(() => useViewerStore.getState().removeModel('primary'));
  await drainTask();
  assert.deepEqual(uploads, [{ id: 32 + offset, index }], 'only the survivor\'s shard uploads, under its own index and offset');
});

it('waits while the drain\'s maps are one render behind the store, then uploads under the owner\'s index and offset', async () => {
  // A Viewport whose maps lag the store: the test publishes them explicitly.
  let publish: () => void = () => { throw new Error('not mounted'); };
  function LaggingViewport() {
    const [models, setModels] = useState(() => useViewerStore.getState().models);
    publish = () => setModels(useViewerStore.getState().models);
    useInstancedShardDrain({
      rendererRef: useRef(renderer), isInitialized: true, gpuRecoveryEpoch: 0, geometryKernel: 'exact', geometry: null,
      modelIdToIndex: modelIndices(models),
      modelIdToOffset: new Map([...models].map(([id, model]) => [id, model.idOffset ?? 0])),
      cameraFittedRef: useRef(false), cameraSnapshotRef: useRef(null),
      geometryBoundsRef: useRef({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }),
      finalBoundsRefittedRef: useRef(false), lastFitPolicyKindRef: useRef(null), lastGeometryRef: useRef(null),
    });
    return null;
  }
  render(<LaggingViewport />);
  const offset = useViewerStore.getState().registerModelOffset('late', 100);
  useViewerStore.setState(fixtureModels(...useViewerStore.getState().models.values(), fixtureModel('late', { idOffset: offset })));
  act(() => enqueueInstancedShards('late', [buildShardBytes(31)], instancedShardGeneration()));
  await drainTask();
  assert.deepEqual(uploads, [], 'never attributed to model 0 while the maps lack its owner');
  assert.equal(hasPendingInstancedShards('late'), true, 'the store lists the owner, so the shard waits');
  act(() => publish());
  await drainTask();
  const index = modelIndices(useViewerStore.getState().models).get('late');
  assert.deepEqual(uploads, [{ id: 31 + offset, index }]);
  assert.equal(hasPendingInstancedShards(), false);
});

it('drops, and counts, a shard whose owner is in neither the maps nor the store', async () => {
  render(<Viewport />);
  const before = instancedShardDrops().ownerless;
  act(() => enqueueInstancedShards('never-published', [buildShardBytes(31), buildShardBytes(32)], instancedShardGeneration()));
  await drainTask();
  assert.deepEqual(uploads, []);
  assert.equal(hasPendingInstancedShards(), false, 'an owner that cannot appear does not hold its bytes in the queue');
  assert.equal(instancedShardDrops().ownerless - before, 2);
});

it('refuses shards from a load that a reset has superseded', async () => {
  render(<Viewport />);
  const before = instancedShardDrops().superseded;
  const staleGeneration = instancedShardGeneration();
  act(() => useViewerStore.getState().resetViewerState()); // the next primary load's reset
  act(() => enqueueInstancedShards('primary', [buildShardBytes(31)], staleGeneration));
  await drainTask();
  assert.deepEqual(uploads, []);
  assert.equal(hasPendingInstancedShards(), false, 'refused on arrival, never queued');
  assert.equal(instancedShardDrops().superseded - before, 1);
  act(() => enqueueInstancedShards('primary', [buildShardBytes(32)], instancedShardGeneration()));
  await drainTask();
  assert.deepEqual(uploads, [{ id: 32, index: modelIndices(useViewerStore.getState().models).get('primary') }], 'the current load still delivers');
});

it('a renderer that throws after uploading does not get the same shards uploaded again', async () => {
  let throwOnce = true;
  const flaky = {
    ...renderer,
    getGPUDevice: () => ({}),
    getScene: renderer.getScene,
    requestRender: () => { if (throwOnce) { throwOnce = false; throw new Error('render request failed'); } },
  } as unknown as Renderer;
  function FlakyViewport() {
    const models = useViewerStore((s) => s.models);
    useInstancedShardDrain({
      rendererRef: useRef(flaky), isInitialized: true, gpuRecoveryEpoch: 0, geometryKernel: 'exact', geometry: null,
      modelIdToIndex: modelIndices(models),
      modelIdToOffset: new Map([...models].map(([id, model]) => [id, model.idOffset ?? 0])),
      cameraFittedRef: useRef(false), cameraSnapshotRef: useRef(null),
      geometryBoundsRef: useRef({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }),
      finalBoundsRefittedRef: useRef(false), lastFitPolicyKindRef: useRef(null), lastGeometryRef: useRef(null),
    });
    return null;
  }
  render(<FlakyViewport />);
  act(() => enqueueInstancedShards('primary', [buildShardBytes(31), buildShardBytes(32)], instancedShardGeneration()));
  await drainTask();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); }); // past any retry backoff
  assert.deepEqual(uploads.map((u) => u.id), [31, 32], 'each shard uploads exactly once despite the throw');
  assert.equal(hasPendingInstancedShards(), false, 'settled shards are not left queued');
});
