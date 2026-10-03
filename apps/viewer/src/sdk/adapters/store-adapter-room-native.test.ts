/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { IfcAPI } from '@ifc-lite/wasm';
import { CoordinateHandler, type GeometryResult } from '@ifc-lite/geometry';
import type { RemeshRequest } from '@ifc-lite/geometry/remesh';
import { applyRemeshConfig, remeshOnApi, styleWireOnApi } from '../../../../../packages/geometry/src/remesh/remesh-core.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { clearStoreyRoomsCache } from '@/lib/rooms/storey-rooms';
import { setRemeshClientFactory, requestRemesh } from '@/lib/remesh/remesh-service';
import { createStoreAdapter } from './store-adapter.js';

const MODEL = 'native', frame = { x: 0, y: 0, z: 0, needsShift: false };
const sample = new URL('../../../public/samples/hello-wall.ifc', import.meta.url);
const requests: RemeshRequest[] = [];
afterEach(() => {
  setRemeshClientFactory(null);
  clearModelLayouts(MODEL);
  clearStoreyRoomsCache();
});
async function seed() {
  const bytes = readFileSync(sample);
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
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const depth = () => useViewerStore.getState().undoStacks.get(MODEL)?.length ?? 0;

it('Room query refreshes its storey while an unrelated upper wall is colour-merged (#6758)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { adapter, store, view } = await seed();
  const points: [number, number, number][] = [[20,20,0],[24,20,0],[24,23,0],[20,23,0]];
  points.forEach((Start, i) => adapter.addWall(MODEL, 42, { Start, End: points[(i + 1) % points.length], Thickness: .2, Height: 3 }));
  const upperWall = adapter.addWall(MODEL, 42, { Start: [40,40,6], End: [44,40,6], Thickness: .2, Height: 3 });
  const spanningWall = adapter.addWall(MODEL, 42, { Start: [30,30,0], End: [34,30,0], Thickness: .2, Height: 9 });
  await settle();
  const editor = new StoreEditor(store, view);
  const upper = editor.addEntity('IfcBuildingStorey', ['2STOREY00000000000000', null, 'Upper', null, null, null, null, null, '.ELEMENT.', 6]).expressId;
  for (const ref of [upperWall, spanningWall]) {
    const containment = view.getNewEntities().find(entity => entity.type === 'IfcRelContainedInSpatialStructure' && Array.isArray(entity.attributes[4]) && entity.attributes[4].includes(`#${ref.expressId}`));
    assert.ok(containment);
    editor.setPositionalAttribute(containment.expressId, 5, `#${upper}`);
  }
  const current = useViewerStore.getState(), model = current.models.get(MODEL)!;
  const geometry = model.geometryResult!;
  const spanningMeshes = geometry.meshes.filter(mesh => mesh.expressId === spanningWall.expressId);
  assert.ok(spanningMeshes.length, 'the spanning wall has actual native geometry');
  const spanBounds = new CoordinateHandler().calculateBounds(spanningMeshes);
  const changed = geometry.meshes.filter(mesh => mesh.expressId !== spanningWall.expressId).map(mesh => mesh.expressId === upperWall.expressId ? { ...mesh, entityIds: Uint32Array.from(mesh.positions.filter((_value, index) => index % 3 === 0), () => 1222) } : mesh);
  useViewerStore.setState({ models: new Map([[MODEL, { ...model, geometryResult: { ...geometry, meshes: changed, instancedGeometryAabbs: new Map([[spanningWall.expressId, { min: [spanBounds.min.x, spanBounds.min.y, spanBounds.min.z], max: [spanBounds.max.x, spanBounds.max.y, spanBounds.max.z] }]]) } }]]) });
  const before = structuredClone(view.getEffectiveChanges()), history = depth();
  assert.deepEqual(await requestRemesh(useViewerStore.getState, MODEL, [upperWall.expressId], 'shape'), { status: 'refused', reason: 'colourMerged' }, 'the unrelated wall genuinely refuses shape remeshing');
  requests.length = 0;
  const result = await adapter.roomCommand!(MODEL, 42, { action: 'query' });
  assert.equal(result.candidates.filter(face => face.centre.some(([x]) => x > 19 && x < 25)).length, 1);
  assert.ok(requests.length > 0, 'query actually used the native remesh worker');
  assert.ok(requests.every(request => !request.targets.includes(upperWall.expressId)), 'unrelated upper-storey wall is outside target refresh');
  assert.ok(requests.some(request => request.targets.includes(spanningWall.expressId)), 'geometry crossing the target height band refreshes even when another storey contains it');
  assert.equal(depth(), history);
  assert.deepEqual(view.getEffectiveChanges(), before);
});

it('layout-only SDK split before IFC rooms uses native viewer Undo and Redo without graph edits (#6758)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { adapter, view } = await seed();
  const points: [number, number, number][] = [[20,20,0],[24,20,0],[24,23,0],[20,23,0]];
  points.forEach((Start, i) => adapter.addWall(MODEL, 42, { Start, End: points[(i + 1) % points.length], Thickness: .2, Height: 3 }));
  await settle();
  const query = () => adapter.roomCommand!(MODEL, 42, { action: 'query' });
  const nearby = (result: Awaited<ReturnType<typeof query>>) => result.candidates.filter(face => face.centre.some(([x]) => x > 19));
  const before = structuredClone(view.getEffectiveChanges()), undo = depth();
  assert.equal(nearby(await query()).length, 1);
  const result = await adapter.roomCommand!(MODEL, 42, { action: 'edit', operation: { kind: 'split', a: [21,20], b: [21,23] } });
  assert.deepEqual([result.created, result.updated, result.deleted], [[], [], []]);
  assert.equal(depth(), undo + 1);
  assert.equal(nearby(await query()).length, 2);
  assert.deepEqual(view.getEffectiveChanges(), before);
  useViewerStore.getState().undo(MODEL);
  assert.equal(depth(), undo);
  assert.equal(nearby(await query()).length, 1);
  assert.deepEqual(view.getEffectiveChanges(), before);
  useViewerStore.getState().redo(MODEL);
  assert.equal(depth(), undo + 1);
  assert.equal(nearby(await query()).length, 2);
  assert.deepEqual(view.getEffectiveChanges(), before);
});
