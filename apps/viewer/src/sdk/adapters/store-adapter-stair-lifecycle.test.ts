/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: real SDK adapter/native remesh, assembly mesh/tree removal and one-step Undo/Redo. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import { registerEntityPath, registerStoreSlot, pathForGuid } from '@/lib/collab/entity-paths';
import { remeshOnApi, styleWireOnApi } from '../../../../../../packages/geometry/src/remesh/remesh-core.js';
import { requestRemesh, setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { toGlobalIdFromModels } from '@/store/globalId';
import { createStoreAdapter } from './store-adapter';

const SAMPLE = new URL('../../../public/samples/hello-wall.ifc', import.meta.url);
const WASM = new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const AVAILABLE = existsSync(SAMPLE) && existsSync(WASM), MODEL = 'bonsai';
afterEach(() => { setRemeshClientFactory(null); useViewerStore.setState({ collabRoomId: null, collabRoomModels: new Map() }); });
function bytes() {
  const state = useViewerStore.getState(), model = state.models.get(MODEL)!;
  return new StepExporter(model.ifcDataStore!, state.mutationViews.get(MODEL)).export({ schema: 'IFC4', applyMutations: true }).content;
}
async function data(content: Uint8Array) {
  const parsed = await new IfcParser().parseColumnar(content.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const extractor = new EntityExtractor(parsed.source);
  return [...parsed.entityIndex.byId].map(([id, location]) => {
    const entity = extractor.extractEntity(location);
    assert.ok(entity, `Actual IFC record #${id} decodes`);
    return [id, entity] as const;
  }).sort((a, b) => a[0] - b[0]);
}
const meshSnapshot = () => useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes.map(mesh => ({
  id: mesh.expressId, positions: Array.from(mesh.positions), normals: Array.from(mesh.normals),
  indices: Array.from(mesh.indices), color: mesh.color, origin: mesh.origin,
}));
for (const count of [1, 2] as const) it(`#6232 SDK stair/${count} native meshes and tree undo as a whole pair; ordinary deletion retained`, { skip: !AVAILABLE }, async () => {
  await seedModelingSession();
  const source = readFileSync(SAMPLE), models = new Map(useViewerStore.getState().models), views = new Map<string, MutablePropertyView>();
  models.clear();
  const geometry = useViewerStore.getState().geometryResult!;
  for (const [i, id] of [MODEL, 'peer'].slice(0, count).entries()) {
    const parsed = await new IfcParser().parseColumnar(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer, { disableWorkerScan: true });
    models.set(id, { ...fixtureModel(id, { idOffset: count === 1 ? 0 : (i + 1) * 1_000_000 }), ifcDataStore: parsed,
      geometryResult: { ...geometry, meshes: [], coordinateInfo: { ...geometry.coordinateInfo, wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false } } } });
    views.set(id, new MutablePropertyView(parsed.properties ?? null, id));
  }
  const store = models.get(MODEL)!.ifcDataStore!, mirrored: number[] = [];
  registerStoreSlot(store, { slotId: 'm0', pathPrefix: '/m0' });
  useViewerStore.setState({ ...fixtureModels(models.get(MODEL)!), models, activeModelId: MODEL,
    geometryResult: models.get(MODEL)!.geometryResult, mutationViews: views, storeEditors: new Map(),
    collabRoomId: 'room', collabRoomModels: new Map([[MODEL, { slotId: 'm0', pathPrefix: '/m0' }]]),
    canCollabEdit: () => true, editEnabled: true,
    mirrorEntityCreate: (_model, id, _type, key) => { if (key) registerEntityPath(store, id, pathForGuid(store, key)); },
    mirrorEntityRemove: (_model, id) => { mirrored.push(id); }, mirrorAttributeEdit: () => {}, mirrorEntityGeometry: () => {},
  });
  initSync({ module: readFileSync(WASM) });
  const api = new IfcAPI();
  try {
    setRemeshClientFactory(async () => ({ alive: true, dispose: () => {}, setConfig: () => {},
      styleWire: async content => styleWireOnApi(api, content), remesh: async request => remeshOnApi(api, request) }));
    const adapter = createStoreAdapter(useViewerStore), create = adapter.addStair, remove = adapter.removeStair;
    assert.ok(create && remove, 'Actual optional SDK capabilities are installed');
    adapter.addEntity(MODEL, { type: 'IfcCartesianPoint', attributes: [[7, 8, 9]] });
    const prior = await data(bytes()), peerGeometry = models.get('peer')?.geometryResult;
    const stair = create(MODEL, 42, { Position: [1, 2, 0], NumberOfRisers: 4, RiserHeight: .2, TreadLength: .3, Width: 1 });
    const created = await data(bytes()), aggregate = created.find(([, e]) => e.type === 'IFCRELAGGREGATES' && e.attributes[4] === stair.expressId)!;
    const parts = aggregate[1].attributes[5];
    assert.ok(Array.isArray(parts) && typeof parts[0] === 'number');
    const flight = parts[0], global = toGlobalIdFromModels(useViewerStore.getState().models, MODEL, flight);
    assert.equal((await requestRemesh(useViewerStore.getState, MODEL, [flight], 'created')).status, 'applied');
    assert.ok(meshSnapshot().some(mesh => mesh.id === global && mesh.indices.length > 0), 'Actual native mesh reaches live geometry');
    const beforeMeshes = meshSnapshot(), beforeStack = useViewerStore.getState().undoStacks.get(MODEL)!.length;
    assert.ok(store.spatialHierarchy!.byStorey.get(42)!.includes(stair.expressId), 'Actual authored tree row');
    assert.equal(remove(stair), true);
    assert.ok(!meshSnapshot().some(mesh => mesh.id === global));
    assert.ok(useViewerStore.getState().removedMeshes.has(`${MODEL}:${flight}`), 'Native mesh retained in canonical stash');
    assert.ok(!store.spatialHierarchy!.byStorey.get(42)!.includes(stair.expressId));
    assert.ok([stair.expressId, flight].every(id => mirrored.includes(id)), 'Both removals reach existing shared-room hook');
    const deleted = await data(bytes());
    assert.ok(!deleted.some(([id]) => id === stair.expressId || id === flight));
    useViewerStore.getState().undo(MODEL);
    assert.equal(useViewerStore.getState().undoStacks.get(MODEL)!.length, beforeStack, 'ONE undo restores both products');
    assert.deepEqual(await data(bytes()), created);
    assert.deepEqual(meshSnapshot(), beforeMeshes);
    assert.ok(store.spatialHierarchy!.byStorey.get(42)!.includes(stair.expressId));
    useViewerStore.getState().redo(MODEL);
    assert.deepEqual(await data(bytes()), deleted);
    assert.ok(!meshSnapshot().some(mesh => mesh.id === global));
    useViewerStore.getState().undo(MODEL);
    // Generic removeEntity continues to remove one row, even for a stair:
    // no undocumented cascade was introduced by the completion extraction.
    assert.equal(adapter.removeEntity(stair), true);
    const rowOnly = await data(bytes());
    assert.ok(rowOnly.some(([id]) => id === flight));
    assert.ok(meshSnapshot().some(mesh => mesh.id === global));
    useViewerStore.getState().undo(MODEL);
    assert.deepEqual(await data(bytes()), created);
    useViewerStore.getState().undo(MODEL);
    assert.deepEqual(await data(bytes()), prior, 'Earlier point/history survives one creation Undo');
    assert.equal(useViewerStore.getState().models.get('peer')?.geometryResult, peerGeometry);
  } finally { setRemeshClientFactory(null); api.free(); }
});
