/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcAPI } from '@ifc-lite/wasm';
import { CoordinateHandler, type GeometryResult } from '@ifc-lite/geometry';
import type { RemeshRequest } from '@ifc-lite/geometry/remesh';
import { applyRemeshConfig, remeshOnApi, styleWireOnApi } from '../../../../../packages/geometry/src/remesh/remesh-core.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { clearStoreyRoomsCache } from '@/lib/rooms/storey-rooms';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
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
const meshes = () => useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes;
const depth = () => useViewerStore.getState().undoStacks.get(MODEL)?.length ?? 0;

it('SDK Duplicate remeshes the actual hosted Bonsai graph and one viewer Undo removes graph and meshes (#6232)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { adapter, view } = await seed();
  const before = structuredClone({ records: view.getNewEntities() });
  const duplicate = adapter.duplicateElement!({ modelId: MODEL, expressId: 1222 }, { offset: [0, 5, 0], Name: 'Native duplicate' });
  await settle();
  const state = useViewerStore.getState();
  const groups = new Set((state.undoStacks.get(MODEL) ?? []).map(mutation => state.mutationBatchTags.get(mutation.id)));
  assert.equal(groups.size, 1, 'the complete duplicate graph is one undo group');
  assert.ok(!groups.has(undefined), 'all graph records belong to that group');
  assert.equal(view.getNewEntity(duplicate.expressId)!.attributes[2], 'Native duplicate');
  assert.equal(view.getNewEntities().filter(row => row.type === 'IfcRelVoidsElement').length, 2);
  assert.equal(view.getNewEntities().filter(row => row.type === 'IfcRelFillsElement').length, 2);
  const hostMeshes = meshes().filter(mesh => mesh.expressId === duplicate.expressId);
  assert.ok(hostMeshes.some(mesh => mesh.indices.length > 3), 'actual Rust wall geometry reached viewer');
  assert.ok(requests.some(request => [...request.targets].includes(duplicate.expressId)), 'Duplicate reached the actual worker core');
  useViewerStore.getState().undo(MODEL);
  await settle();
  assert.equal(depth(), 0);
  assert.deepEqual({ records: view.getNewEntities() }, before);
  assert.ok(!meshes().some(mesh => mesh.expressId === duplicate.expressId));
});

it('SDK Room derives current native meshes and cut Undo restores IFC, renderer and shared DCEL (#6232)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { adapter, view } = await seed();
  const empty = structuredClone({ records: view.getNewEntities() });
  const wall = adapter.addWall(MODEL, 42, { Start: [20,20,0], End: [24,20,0], Thickness: .2, Height: 3 });
  await settle();
  assert.ok(meshes().some(mesh => mesh.expressId === wall.expressId));
  useViewerStore.getState().undo(MODEL);
  await settle();
  assert.deepEqual({ records: view.getNewEntities() }, empty, 'ordinary wall Undo removes all auxiliary IFC records');
  assert.ok(!meshes().some(mesh => mesh.expressId === wall.expressId));
  const points: [number, number, number][] = [[20,20,0],[24,20,0],[24,23,0],[20,23,0]];
  points.forEach((Start, i) => adapter.addWall(MODEL, 42, { Start, End: points[(i + 1) % points.length], Thickness: .2, Height: 3 }));
  await settle();
  const picked = await adapter.roomCommand!(MODEL, 42, { action: 'pick', point: [22,21], namePattern: 'Native Room {n}' });
  assert.equal(picked.created.length, 1);
  await settle();
  const ref = picked.created[0], guid = view.getNewEntity(ref.expressId)!.attributes[0];
  assert.ok(meshes().some(mesh => mesh.expressId === ref.expressId && mesh.indices.length > 3), 'new Room actual native mesh reached viewer');
  const before = structuredClone({ records: view.getNewEntities() }), undo = depth();
  const cut = await adapter.roomCommand!(MODEL, 42, { action: 'edit', operation: { kind: 'split', a: [21,20], b: [21,23] } });
  assert.equal(cut.created.length, 1);
  await settle();
  assert.ok(depth() > undo);
  const state = useViewerStore.getState(), operations = state.undoStacks.get(MODEL)!.slice(undo);
  assert.equal(new Set(operations.map(mutation => state.mutationBatchTags.get(mutation.id))).size, 1, 'cut is one compound undo group');
  assert.equal(view.getNewEntity(ref.expressId)!.attributes[0], guid);
  assert.ok(meshes().some(mesh => mesh.expressId === cut.created[0].expressId), 'split sibling rendered');
  const query = () => adapter.roomCommand!(MODEL, 42, { action: 'query' });
  const nearby = (result: Awaited<ReturnType<typeof query>>) => result.candidates.filter(face => face.centre.some(([x]) => x > 19));
  assert.equal(nearby(await query()).length, 2);
  useViewerStore.getState().undo(MODEL);
  await settle();
  assert.equal(depth(), undo);
  assert.deepEqual({ records: view.getNewEntities() }, before);
  assert.ok(!meshes().some(mesh => mesh.expressId === cut.created[0].expressId));
  assert.equal(nearby(await query()).length, 1);
});
