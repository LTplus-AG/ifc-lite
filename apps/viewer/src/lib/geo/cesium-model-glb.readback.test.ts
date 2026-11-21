/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10887 r4647377537: the world-view (Cesium) build reads back only the released models its geometry shows.
 * With model A released WITHOUT a complete backing and outside the view, building resident model B's view
 * must neither be refused nor depend on A's backing.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { RefObject } from 'react';
import type { StoreApi } from 'zustand';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '../../hooks/useBCF.js';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { activeGeometryBackingTap, geometryBackingCommand } from '@/lib/geometry-backing/backing-debug-hook';
import type { TapState } from '@/lib/geometry-backing/store-backing-tap';
import { buildCesiumModelForView, cesiumModelScope, type CesiumModelGLBInput } from './cesium-model-glb.js';

function mesh(expressId: number, z: number, modelIndex?: number): MeshData {
  return { expressId, ifcType: 'IfcWall', positions: Float32Array.from([0, 0, z, 1, 0, z, 0, 1, z]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1],
    ...(modelIndex !== undefined ? { modelIndex } : {}) };
}

it('#10887 r4647377537 building a resident model\'s world view ignores a released model outside it', async () => {
  const released = [mesh(1, 0)], resident = [mesh(201, 5)];
  useViewerStore.setState({ models: new Map([
    ['rel', { id: 'rel', idOffset: 0, maxExpressId: 100, geometryResult: { meshes: released } }],
    ['res', { id: 'res', idOffset: 200, maxExpressId: 100, geometryResult: { meshes: resident } }],
  ]) } as never);
  const index = modelIndices(useViewerStore.getState().models);
  let sceneReleased = false;
  const scene = { isGeometryDataReleased: () => sceneReleased, getInstancedModelIndices: () => [] as number[],
    placeAppearanceSource: (m: MeshData) => ({ ...m }), getAllInstancedMeshData: () => [] as MeshData[], getInstancedEntityCount: () => 0 };
  setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer } as RefObject<Renderer | null>);
  const store = useViewerStore as unknown as StoreApi<TapState>;
  try {
    await geometryBackingCommand(store, undefined, { action: 'start', options: { database: { name: `cesium-scope-${process.pid}`, locks: null } } as never });
    await activeGeometryBackingTap()!.whenIdle(); // never sealed: A has no complete backing
    sceneReleased = true;
    releaseCpuMeshBuffers(released);
    // What the overlay receives: the merged, visibility-filtered view (A hidden), as federation copies.
    const view: GeometryResult = { meshes: resident.map((m) => ({ ...m, modelIndex: index.get('res') })), totalTriangles: 1, totalVertices: 3,
      coordinateInfo: {} as GeometryResult['coordinateInfo'] };
    assert.deepEqual(cesiumModelScope(view), ['res'], 'the view shows B only');
    const input: CesiumModelGLBInput = { geometryResult: view, geometryContentVersion: 0, hiddenIds: null, isolatedIds: null,
      visibilityVersion: 0, ghostExceptIds: null, selectedIds: null, ghostVersion: 0 };
    const built = await buildCesiumModelForView(input);
    assert.ok(built.parts.length > 0, "B's world view is built, not refused for A's missing backing");
  } finally {
    await geometryBackingCommand(store, undefined, { action: 'stop' });
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  }
});
