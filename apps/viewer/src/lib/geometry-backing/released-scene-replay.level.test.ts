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
import { releasedReplaysIdle, splitReleasedForReplay, supersedeReleasedReplays } from './released-scene-replay';

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
    const place = (m: MeshData) => ({ id: m.expressId, origin: m.origin ?? null, positions: [...m.positions] });
    assert.deepEqual(uploaded.map(place).sort((a, b) => a.id - b.id), resident.map(place).sort((a, b) => a.id - b.id),
      'entity 2 arrives lifted by 3.5, entity 1 unlifted: the same placement as the resident upload');
  } finally {
    supersedeReleasedReplays();
    await geometryBackingCommand(tapStore, undefined, { action: 'stop' });
  }
});
