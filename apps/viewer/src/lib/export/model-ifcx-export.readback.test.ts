/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10887 r4647096042: an IFCX export of one model runs in a preparation scoped to that model, so its
 * collector must use that model's range even when the caller passes no `maxExpressId`. With another
 * model released and this one resident, the unscoped null range made the collector see the released
 * scene and refuse an export that needs no readback.
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
import { geometryBackingCommand } from '@/lib/geometry-backing/backing-debug-hook';
import type { TapState } from '@/lib/geometry-backing/store-backing-tap';
import type { FederatedModel } from '@/store/types';
import { withIfcxModelGeometry } from './model-ifcx-export.js';

function mesh(expressId: number, z: number, modelIndex?: number): MeshData {
  return { expressId, ifcType: 'IfcWall', positions: Float32Array.from([0, 0, z, 1, 0, z, 0, 1, z]),
    normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1], ...(modelIndex !== undefined ? { modelIndex } : {}) };
}
const result = (meshes: MeshData[]): GeometryResult => ({ meshes, totalTriangles: meshes.length, totalVertices: meshes.length * 3,
  coordinateInfo: {} as GeometryResult['coordinateInfo'] });

it('#10887 r4647096042 exporting a resident model without maxExpressId while another is released keeps its own range', async () => {
  const released = result([mesh(1, 0)]);
  const resident = result([mesh(201, 5)]);
  useViewerStore.setState({ models: new Map([
    ['rel', { id: 'rel', idOffset: 0, maxExpressId: 100, geometryResult: released }],
    ['res', { id: 'res', idOffset: 200, maxExpressId: 100, geometryResult: resident }],
  ]) } as never);
  const models = useViewerStore.getState().models as ReadonlyMap<string, FederatedModel>;
  const index = modelIndices(models);
  const residentOccurrence = mesh(250, 9, index.get('res'));
  let sceneReleased = false;
  const scene = {
    isGeometryDataReleased: () => sceneReleased,
    getInstancedModelIndices: () => [index.get('rel')!], // only the released model's instancing left the GPU copy
    placeAppearanceSource: (m: MeshData) => ({ ...m }),
    getAllInstancedMeshData: () => [residentOccurrence],
  };
  setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer } as RefObject<Renderer | null>);
  const store = useViewerStore as unknown as StoreApi<TapState>;
  try {
    await geometryBackingCommand(store, undefined, { action: 'start', options: { database: { name: `ifcx-scope-${process.pid}`, locks: null } } as never });
    await geometryBackingCommand(store, undefined, { action: 'seal' });
    sceneReleased = true;
    releaseCpuMeshBuffers(released.meshes); // model A released; B stays resident
    const exported = await withIfcxModelGeometry({ modelId: 'res', geometryResult: resident, idOffset: 200, models }, (g) => g);
    assert.ok(exported);
    assert.deepEqual(exported.meshes.map((m) => m.expressId), [201, 250], "B's flat mesh and its own occurrence, nothing of A");
    assert.deepEqual([...exported.meshes[0].positions], [0, 0, 5, 1, 0, 5, 0, 1, 5], 'its resident arrays, unchanged');
  } finally {
    await geometryBackingCommand(store, undefined, { action: 'stop' });
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  }
});

it('#11216 exporting from a captured federation keeps newly loaded renderer indices', async (t) => {
  const initial = useViewerStore.getState().models;
  t.after(() => { useViewerStore.setState({ models: initial }); modelIndices(initial); });
  const a = { id: 'exported' } as FederatedModel;
  const b = { id: 'loaded-during-export' } as FederatedModel;
  const models = new Map([[a.id, a]]);
  useViewerStore.setState({ models });
  modelIndices(models);

  const pending = withIfcxModelGeometry({ modelId: a.id, geometryResult: null, idOffset: 0, models }, () => 'exported');
  const live = new Map([...models, [b.id, b]]);
  useViewerStore.setState({ models: live });
  const index = modelIndices(live).get(b.id);
  assert.notEqual(index, undefined);

  assert.equal(await pending, 'exported');
  assert.equal(modelIndices(live).get(b.id), index, 'export must not evict the live assignment');
});
