/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StoreApi } from 'zustand';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { ReleasedSceneRebuildContext } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { geometryBackingCommand } from './backing-debug-hook';
import type { TapState } from './store-backing-tap';
import { noteSceneGeometry } from './released-scene-replay';
import { rebuildReleasedScene } from './released-device-recovery';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { enqueueInstancedShards, instancedShardSupplyToken } from '@/store/instancedShardQueue';

function mesh(expressId: number, z: number): MeshData {
  return { expressId, ifcType: 'IfcWall', positions: Float32Array.from([0, 0, z, 1, 0, z, 0, 1, z]),
    normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] };
}

/** A scene that records what the rebuild uploads; `onAppend` runs inside the first upload. */
function recordingScene(onAppend?: () => void) {
  const uploaded: number[][] = [];
  let ephemeral = false;
  const scene = {
    streamingFragments: [] as unknown[], batchedMeshes: [] as unknown[], // the fragment lists the replay owns
    boundingBoxes: new Map(), modelTranslations: { releasedEntities: new Map() }, // and the bounds it may roll back
    setEphemeralStreamingMode: (on: boolean) => { ephemeral = on; },
    isEphemeralStreaming: () => ephemeral,
    appendToBatches: (batch: MeshData[]) => { uploaded.push(...batch.map((m) => [...m.positions])); onAppend?.(); onAppend = undefined; },
    finalizeStreamingAsync: async () => { ephemeral = false; },
    addInstancedShard: () => undefined,
  };
  const context = { device: {} as GPUDevice, pipeline: {} as never, scene: scene as never, instancedModelIndices: new Set<number>([0]), isCurrent: () => true,
    requestRender: () => undefined } as ReleasedSceneRebuildContext;
  return { context, uploaded };
}

async function releasedModel(name: string) {
  const meshes = [mesh(1, 0), mesh(2, 4)];
  const bytes = meshes.map((m) => [...m.positions]);
  const geometryResult: GeometryResult = { meshes, totalTriangles: 2, totalVertices: 6, coordinateInfo: {} as GeometryResult['coordinateInfo'] };
  useViewerStore.setState({ models: new Map([['rm', { id: 'rm', idOffset: 0, maxExpressId: 10, geometryResult }]]) } as never);
  const store = useViewerStore as unknown as StoreApi<TapState>;
  await geometryBackingCommand(store, undefined, { action: 'start', options: { database: { name, locks: null } } as never });
  const [status] = await geometryBackingCommand(store, undefined, { action: 'seal' }) as Array<{ complete: boolean }>;
  assert.equal(status.complete, true);
  releaseCpuMeshBuffers(meshes);
  noteSceneGeometry(meshes);
  return { store, bytes };
}

describe('released device recovery rebuild (viewer)', () => {
  it('puts the drawn released meshes back exactly from the backing', async () => {
    const { store, bytes } = await releasedModel(`recovery-ok-${process.pid}`);
    try {
      const { context, uploaded } = recordingScene();
      assert.equal(await rebuildReleasedScene(context), true);
      assert.deepEqual(uploaded, bytes);
    } finally { await geometryBackingCommand(store, undefined, { action: 'stop' }); }
  });

  it('#PR8 a model replaced during the backing read fences the rebuild: it never reports whole', async () => {
    const { store } = await releasedModel(`recovery-replaced-${process.pid}`);
    try {
      const { context } = recordingScene(() => {
        // The model is replaced (a reload, a collab reconstruct) while the replay is awaiting the backing.
        useViewerStore.setState({ models: new Map([['rm', { id: 'rm', idOffset: 0, maxExpressId: 10,
          geometryResult: { meshes: [mesh(9, 1)], totalTriangles: 1, totalVertices: 3, coordinateInfo: {} } }]]) } as never);
      });
      assert.equal(await rebuildReleasedScene(context), false, 'the old source must not be published as the recovered scene');
    } finally { await geometryBackingCommand(store, undefined, { action: 'stop' }); }
  });

  it('#PR8 a content-version change during the backing read fences the rebuild', async () => {
    const { store } = await releasedModel(`recovery-bumped-${process.pid}`);
    try {
      const { context } = recordingScene(() => useViewerStore.getState().bumpGeometryContentVersion());
      assert.equal(await rebuildReleasedScene(context), false);
    } finally { await geometryBackingCommand(store, undefined, { action: 'stop' }); }
  });

  it('#10937 an unrecorded drawn list (a snapshot hydration never noted) fails closed instead of rebuilding an empty scene', async () => {
    const { store } = await releasedModel(`recovery-unrecorded-${process.pid}`);
    try {
      noteSceneGeometry(undefined);
      const { context, uploaded } = recordingScene();
      assert.equal(await rebuildReleasedScene(context), false, 'never a "recovered" scene with its flat geometry missing');
      assert.deepEqual(uploaded, []);
    } finally { await geometryBackingCommand(store, undefined, { action: 'stop' }); }
  });

  it('#10937 a mesh appended IN PLACE to the drawn and store lists during the read fences the rebuild', async () => {
    const { store } = await releasedModel(`recovery-appended-${process.pid}`);
    try {
      const { context } = recordingScene(() => {
        // Same arrays, one more member: the identity fence alone would pass and the snapshot would miss it.
        const list = useViewerStore.getState().models.get('rm')!.geometryResult!.meshes;
        list.push(mesh(7, 9));
      });
      assert.equal(await rebuildReleasedScene(context), false, 'never "whole" without the appended mesh');
    } finally { await geometryBackingCommand(store, undefined, { action: 'stop' }); }
  });

  it('#10937 every flat type hidden (a RECORDED empty list) still recovers the instanced occurrences', async () => {
    const meshes = [mesh(1, 0)];
    const geometryResult: GeometryResult = { meshes, totalTriangles: 1, totalVertices: 3, coordinateInfo: {} as GeometryResult['coordinateInfo'] };
    useViewerStore.setState({ models: new Map([['ih', { id: 'ih', idOffset: 0, maxExpressId: 100, geometryResult }]]) } as never);
    const store = useViewerStore as unknown as StoreApi<TapState>;
    await geometryBackingCommand(store, undefined, { action: 'start', options: { database: { name: `recovery-hidden-${process.pid}`, locks: null } } as never });
    try {
      enqueueInstancedShards('ih', [shardBytes(77)], instancedShardSupplyToken('ih'));
      const [status] = await geometryBackingCommand(store, undefined, { action: 'seal' }) as Array<{ complete: boolean }>;
      assert.equal(status.complete, true);
      releaseCpuMeshBuffers(meshes);
      noteSceneGeometry([]); // the scene draws no flat mesh: all of them are type-hidden
      const { context, uploaded } = recordingScene();
      const shards: number[] = [];
      (context.scene as unknown as { addInstancedShard: (d: unknown, shard: { instances: Array<{ entityId: number }> }) => void })
        .addInstancedShard = (_d, shard) => { shards.push(...shard.instances.map((i) => i.entityId)); };
      const drewTemplates = new Set([modelIndices(useViewerStore.getState().models).get('ih')!]); // the scene held ih's templates
      assert.equal(await rebuildReleasedScene({ ...context, instancedModelIndices: drewTemplates }), true, 'a recorded empty flat list is not an unrecorded one');
      assert.deepEqual(uploaded, [], 'no flat geometry is drawn');
      assert.deepEqual(shards, [77], 'the instanced occurrence is restaged');
    } finally { await geometryBackingCommand(store, undefined, { action: 'stop' }); }
  });

  it('#10937 a model whose instanced templates were not in the scene before the loss is not restaged', async () => {
    const meshes = [mesh(1, 0)];
    const geometryResult: GeometryResult = { meshes, totalTriangles: 1, totalVertices: 3, coordinateInfo: {} as GeometryResult['coordinateInfo'] };
    useViewerStore.setState({ models: new Map([['hm', { id: 'hm', idOffset: 0, maxExpressId: 100, geometryResult }]]) } as never);
    const store = useViewerStore as unknown as StoreApi<TapState>;
    await geometryBackingCommand(store, undefined, { action: 'start', options: { database: { name: `recovery-hidden-model-${process.pid}`, locks: null } } as never });
    try {
      enqueueInstancedShards('hm', [shardBytes(77)], instancedShardSupplyToken('hm'));
      await geometryBackingCommand(store, undefined, { action: 'seal' });
      releaseCpuMeshBuffers(meshes);
      noteSceneGeometry(meshes);
      const { context } = recordingScene();
      const shards: number[] = [];
      (context.scene as unknown as { addInstancedShard: (d: unknown, shard: { instances: Array<{ entityId: number }> }) => void })
        .addInstancedShard = (_d, shard) => { shards.push(...shard.instances.map((i) => i.entityId)); };
      // The model is hidden: the scene had removed its templates before the device was lost.
      assert.equal(await rebuildReleasedScene({ ...context, instancedModelIndices: new Set<number>() }), true);
      assert.deepEqual(shards, [], 'never re-added (and drawn) on recovery');
    } finally { await geometryBackingCommand(store, undefined, { action: 'stop' }); }
  });

  it('#10937 an Exploded lift change during the backing read fences the rebuild', async () => {
    const { store } = await releasedModel(`recovery-lift-${process.pid}`);
    try {
      const { context } = recordingScene(() => {
        useViewerStore.setState({ appliedEntityLevelOffsets: new Map([[1, 2.5]]) } as never); // Exploded applied meanwhile
      });
      assert.equal(await rebuildReleasedScene(context), false, 'never publish pieces placed at the old lift');
    } finally { await geometryBackingCommand(store, undefined, { action: 'stop' }); }
  });
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
