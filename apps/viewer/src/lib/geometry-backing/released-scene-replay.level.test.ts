/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10903: a released content reload replays its meshes from the backing with the
 * same Exploded arrival placement a resident upload gets
 * (`placeNewMeshesAtCurrentLevel` at the current lift), through the real backing
 * tap and the real `replayReleasedGeometry`.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { StoreApi } from 'zustand';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { currentLevelYForModels, placeNewMeshesAtCurrentLevel } from '@/lib/level-arrival';
import { geometryBackingCommand } from './backing-debug-hook';
import type { TapState } from './store-backing-tap';
import { completeAfterReleasedReplays, releasedReplaysIdle, splitReleasedForReplay, supersedeReleasedReplays } from './released-scene-replay';

function mesh(expressId: number, z: number): MeshData {
  return { expressId, ifcType: 'IfcWall', positions: Float32Array.from([0, 0, z, 1, 0, z, 0, 1, z]),
    normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] };
}

it('#10903 an Exploded released content reload places replayed meshes exactly as the resident upload does', async () => {
  const meshes = [mesh(1, 0), mesh(2, 4)];
  const store = { id: 'ds' };
  const geometryResult: GeometryResult = { meshes, totalTriangles: 2, totalVertices: 6, coordinateInfo: {} as GeometryResult['coordinateInfo'] };
  useViewerStore.setState({ models: new Map([['rl', { id: 'rl', idOffset: 0, maxExpressId: 10, geometryResult, ifcDataStore: store }]]),
    appliedEntityLevelOffsets: new Map([['rl', { store, offsets: new Map([[2, 3.5]]) }]]) } as never);
  const tapStore = useViewerStore as unknown as StoreApi<TapState>;
  await geometryBackingCommand(tapStore, undefined, { action: 'start', options: { database: { name: `replay-level-${process.pid}`, locks: null } } as never });
  try {
    const [status] = await geometryBackingCommand(tapStore, undefined, { action: 'seal' }) as Array<{ complete: boolean }>;
    assert.equal(status.complete, true);
    // What a resident upload would hand the scene at this lift.
    const state = useViewerStore.getState();
    const resident = placeNewMeshesAtCurrentLevel(meshes.map((m) => ({ ...m, positions: m.positions.slice() })),
      currentLevelYForModels(state.models, state.appliedEntityLevelOffsets));
    releaseCpuMeshBuffers(meshes);
    const uploaded: MeshData[] = [];
    let ephemeral = false;
    const scene = { streamingFragments: [], batchedMeshes: [], boundingBoxes: new Map(), modelTranslations: { releasedEntities: new Map() },
      setEphemeralStreamingMode: (on: boolean) => { ephemeral = on; }, isEphemeralStreaming: () => ephemeral,
      appendToBatches: (batch: MeshData[]) => { uploaded.push(...batch); }, finalizeStreamingAsync: async () => { ephemeral = false; } };
    const device = {}, pipeline = {};
    const renderer = { getScene: () => scene, getGPUDevice: () => device, getPipeline: () => pipeline, requestRender() {} } as unknown as Renderer;
    assert.deepEqual(splitReleasedForReplay(renderer, meshes), [], 'released-only: everything is replayed');
    await releasedReplaysIdle();
    // Independent of placeNewMeshesAtCurrentLevel: each uploaded mesh's world box (positions + origin),
    // computed here. Entity 2 is lifted +3.5 in Y (renderer Y up); entity 1 has no offset and stays.
    const worldBox = (m: MeshData) => {
      const o = m.origin ?? [0, 0, 0], p = m.positions;
      const axis = (k: number) => { const v = [p[k] + o[k], p[k + 3] + o[k], p[k + 6] + o[k]]; return [Math.min(...v), Math.max(...v)]; };
      return { id: m.expressId, x: axis(0), y: axis(1), z: axis(2) };
    };
    assert.deepEqual(uploaded.map(worldBox).sort((a, b) => a.id - b.id), [
      { id: 1, x: [0, 1], y: [0, 1], z: [0, 0] },
      { id: 2, x: [0, 1], y: [3.5, 4.5], z: [4, 4] },
    ], 'entity 2 is drawn 3.5 higher; entity 1 exactly where it was');
    const place = (m: MeshData) => ({ id: m.expressId, origin: m.origin ?? null, positions: [...m.positions] });
    assert.deepEqual(uploaded.map(place).sort((a, b) => a.id - b.id), resident.map(place).sort((a, b) => a.id - b.id),
      'entity 2 arrives lifted by 3.5, entity 1 unlifted: the same placement as the resident upload');
  } finally {
    supersedeReleasedReplays();
    await geometryBackingCommand(tapStore, undefined, { action: 'stop' });
  }
});

it('#10903 an Exploded lift change during every bounded attempt never parks the replay: it lands once the lift is stable', async () => {
  const meshes = [mesh(1, 0), mesh(2, 4)];
  const store = { id: 'lm' };
  const geometryResult: GeometryResult = { meshes, totalTriangles: 2, totalVertices: 6, coordinateInfo: {} as GeometryResult['coordinateInfo'] };
  const lift = (y: number) => new Map([['lm', { store, offsets: new Map([[2, y]]) }]]);
  useViewerStore.setState({ models: new Map([['lm', { id: 'lm', idOffset: 0, maxExpressId: 10, geometryResult, ifcDataStore: store }]]),
    appliedEntityLevelOffsets: lift(1) } as never);
  const tapStore = useViewerStore as unknown as StoreApi<TapState>;
  await geometryBackingCommand(tapStore, undefined, { action: 'start', options: { database: { name: `replay-lift-${process.pid}`, locks: null } } as never });
  try {
    const [status] = await geometryBackingCommand(tapStore, undefined, { action: 'seal' }) as Array<{ complete: boolean }>;
    assert.equal(status.complete, true);
    releaseCpuMeshBuffers(meshes);
    // The lift moves while each of the first three attempts uploads: every one is superseded by placement alone.
    const attempts: number[][] = [];
    let last: MeshData[] = [];
    let ephemeral = false;
    const scene = { streamingFragments: [], batchedMeshes: [], boundingBoxes: new Map(), modelTranslations: { releasedEntities: new Map() },
      setEphemeralStreamingMode: (on: boolean) => { ephemeral = on; }, isEphemeralStreaming: () => ephemeral,
      appendToBatches: (batch: MeshData[]) => {
        attempts.push(batch.map((m) => m.expressId)); last = batch;
        if (attempts.length <= 3) useViewerStore.setState({ appliedEntityLevelOffsets: lift(1 + attempts.length) } as never);
      },
      finalizeStreamingAsync: async () => { ephemeral = false; } };
    const device = {}, pipeline = {};
    const renderer = { getScene: () => scene, getGPUDevice: () => device, getPipeline: () => pipeline, requestRender() {} } as unknown as Renderer;
    let complete = false;
    splitReleasedForReplay(renderer, meshes);
    completeAfterReleasedReplays(() => { complete = true; });
    await releasedReplaysIdle();
    assert.equal(attempts.length, 4, 'three placement-superseded attempts, then one at the settled lift');
    assert.equal(complete, true, 'the replay completed without any backing notification');
    // The landed upload is placed at the settled lift (1 + 3 moves): entity 2's world Y spans [4, 5].
    const lifted = last.find((m) => m.expressId === 2)!, oy = lifted.origin?.[1] ?? 0;
    const ys = [lifted.positions[1], lifted.positions[4], lifted.positions[7]].map((y) => y + oy);
    assert.deepEqual([Math.min(...ys), Math.max(...ys)], [4, 5], 'the settled retry uses the final lift');
  } finally {
    supersedeReleasedReplays();
    await geometryBackingCommand(tapStore, undefined, { action: 'stop' });
  }
});
