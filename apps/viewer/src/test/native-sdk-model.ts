/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Actual Bonsai model and canonical WASM remesh core for public viewer SDK controls (#6232). */
import { readFileSync } from 'node:fs';
import { IfcParser, getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcAPI } from '@ifc-lite/wasm';
import { CoordinateHandler, type GeometryResult } from '@ifc-lite/geometry';
import type { RemeshRequest } from '@ifc-lite/geometry/remesh';
import { applyRemeshConfig, remeshOnApi, styleWireOnApi } from '../../../../packages/geometry/src/remesh/remesh-core.js';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { setRemeshClientFactory, requestRemesh } from '@/lib/remesh/remesh-service';
import { createStoreAdapter } from '@/sdk/adapters/store-adapter.js';

export const MODEL = 'native';
const frame = { x: 0, y: 0, z: 0, needsShift: false };
const sample = new URL('../../public/samples/hello-wall.ifc', import.meta.url);
export const requests: RemeshRequest[] = [];
export async function seedNativeSdkModel(sourceBytes?: Uint8Array) {
  const bytes = sourceBytes?.slice() ?? readFileSync(sample);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  const api = new IfcAPI();
  const config = { mergeLayers: false, tessellationQuality: null, skipSmallCuts: false, rectParamFastPath: true } as const;
  applyRemeshConfig(api, config);
  const wire = styleWireOnApi(api, bytes);
  const loaded = remeshOnApi(api, { buffer: bytes, targets: Uint32Array.of(1222, 1262), frame, ...wire });
  const bounds = new CoordinateHandler().calculateBounds(loaded.meshes);
  const geometry: GeometryResult = { meshes: loaded.meshes, totalTriangles: loaded.meshes.reduce((n, mesh) => n + mesh.indices.length / 3, 0), totalVertices: loaded.meshes.reduce((n, mesh) => n + mesh.positions.length / 3, 0), coordinateInfo: { wasmRtcFrame: frame, originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel(MODEL), ifcDataStore: store, geometryResult: geometry }),
    geometryResult: geometry, editEnabled: true, collabRoomId: null, canCollabEdit: () => true,
    mutationViews: new Map([[MODEL, new MutablePropertyView(store.properties ?? null, MODEL)]]),
    storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(),
    removedNewEntities: new Map(), removedMeshes: new Map(), pendingMeshRemovals: null, pendingMeshEdits: null, mutationVersion: 0,
  });
  requests.length = 0;
  setRemeshClientFactory(async next => {
    applyRemeshConfig(api, next);
    return { alive: true, setConfig: cfg => applyRemeshConfig(api, cfg), dispose: () => api.free(),
      styleWire: async source => styleWireOnApi(api, source),
      remesh: async request => { requests.push(request); return remeshOnApi(api, request); } };
  });
  return { store, adapter: createStoreAdapter(useViewerStore), view: useViewerStore.getState().mutationViews.get(MODEL)! };
}
/** Await an actual consolidated native refresh, including writes whose worker
 * startup has not yet reached the fixture client. No timer count is evidence. */
export async function settle(modelId = MODEL): Promise<void> {
  const state = useViewerStore.getState(), model = state.models.get(modelId)!;
  const ids = new Set((model.geometryResult?.meshes ?? []).map(mesh => mesh.expressId));
  for (const entity of state.mutationViews.get(modelId)?.getNewEntities() ?? []) {
    if (getInheritanceChainAcrossSchemas(entity.type).includes('IfcProduct')) ids.add(toGlobalIdFromModels(state.models, modelId, entity.expressId));
  }
  const localIds = [...ids].flatMap(id => {
    const ref = state.resolveGlobalIdFromModels(id);
    return ref?.modelId === modelId ? [ref.expressId] : [];
  });
  if (localIds.length) assert.equal((await requestRemesh(useViewerStore.getState, modelId, localIds, 'shape')).status, 'applied');
}
export const nativeSdkMeshes = () => useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes;
export const nativeSdkUndoDepth = () => useViewerStore.getState().undoStacks.get(MODEL)?.length ?? 0;
