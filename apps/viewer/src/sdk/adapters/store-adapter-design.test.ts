/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: actual viewer adapter, real Bonsai source/native mesher, compound Undo/Redo and peer isolation. */
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
import { settleRemesh } from '@/test/scripted-mesher';
import { remeshOnApi, styleWireOnApi } from '../../../../../packages/geometry/src/remesh/remesh-core.js';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { toGlobalIdFromModels } from '@/store/globalId';
import { createStoreAdapter } from './store-adapter';

const SAMPLE = new URL('../../../public/samples/hello-wall.ifc', import.meta.url);
const WASM = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const MODEL = 'design';
afterEach(() => { setRemeshClientFactory(null); useViewerStore.setState({ collabRoomId: null, collabRoomModels: new Map() }); });
function bytes() {
  const state = useViewerStore.getState();
  return new StepExporter(state.models.get(MODEL)!.ifcDataStore!, state.mutationViews.get(MODEL)).export({ schema: 'IFC4', applyMutations: true }).content;
}
async function rows() {
  const parsed = await new IfcParser().parseColumnar(bytes().slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const extractor = new EntityExtractor(parsed.source);
  return [...parsed.entityIndex.byId].map(([id, location]) => [id, extractor.extractEntity(location)] as const).sort((a, b) => a[0] - b[0]);
}
const meshes = () => useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes;

for (const count of [1, 2]) it(`#6232 SDK design creation publishes real bodies and one Undo/Redo with ${count} model(s)`,
  { skip: existsSync(WASM) ? false : 'Run pnpm build:wasm (pnpm fixtures for optional models) for the native geometry proof' }, async () => {
  await seedModelingSession();
  const geometry = useViewerStore.getState().geometryResult!;
  const models = new Map(useViewerStore.getState().models), views = new Map<string, MutablePropertyView>();
  models.clear();
  for (const [i, id] of [MODEL, 'peer'].slice(0, count).entries()) {
    const source = readFileSync(SAMPLE);
    const parsed = await new IfcParser().parseColumnar(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer, { disableWorkerScan: true });
    models.set(id, { ...fixtureModel(id, { idOffset: count === 1 ? 0 : (i + 1) * 1_000_000 }), ifcDataStore: parsed,
      geometryResult: { ...geometry, meshes: [], coordinateInfo: { ...geometry.coordinateInfo, wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false } } } });
    views.set(id, new MutablePropertyView(parsed.properties ?? null, id));
  }
  useViewerStore.setState({ ...fixtureModels(models.get(MODEL)!), models, activeModelId: MODEL,
    geometryResult: models.get(MODEL)!.geometryResult, mutationViews: views, storeEditors: new Map(), editEnabled: true,
  });
  const peerGeometry = models.get('peer')?.geometryResult;
  initSync({ module: readFileSync(WASM) });
  const api = new IfcAPI();
  try {
    setRemeshClientFactory(async () => ({ alive: true, dispose: () => {}, setConfig: () => {},
      styleWire: async content => styleWireOnApi(api, content), remesh: async request => remeshOnApi(api, request) }));
    const adapter = createStoreAdapter(useViewerStore), add = adapter.addCurtainWall, addGrid = adapter.addGrid, addColumn = adapter.addColumnOnGrid;
    assert.ok(add && addGrid && addColumn, 'All actual SDK capabilities are installed');
    const before = await rows();
    const wall = add(MODEL, 42, { Start: [0, 5, 0], End: [4, 5, 0], Height: 3, UGrid: 2, VGrid: 2 });
    await settleRemesh();
    const created = await rows();
    const aggregate = created.find(([, e]) => e?.type === 'IFCRELAGGREGATES' && e.attributes[4] === wall.expressId)?.[1];
    const partIds = aggregate?.attributes[5];
    assert.ok(Array.isArray(partIds) && partIds.every(id => typeof id === 'number'));
    const globals = partIds.map(id => toGlobalIdFromModels(useViewerStore.getState().models, MODEL, id as number));
    assert.ok(globals.every(id => meshes().some(mesh => mesh.expressId === id && mesh.indices.length > 0)), 'Automatic SDK completion publishes every native part');
    const native = meshes().map(mesh => ({ id: mesh.expressId, positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) }));
    const state = useViewerStore.getState(), stack = state.undoStacks.get(MODEL)!.length, journal = views.get(MODEL)!.getMutations();
    assert.ok(state.models.get(MODEL)!.ifcDataStore!.spatialHierarchy!.byStorey.get(42)!.includes(wall.expressId));
    assert.throws(() => add(MODEL, 42, { Start: [0, 5, 0], End: [4, 5, 0], Height: 3, PanelThickness: -1 }));
    assert.deepEqual(await rows(), created);
    assert.deepEqual(views.get(MODEL)!.getMutations(), journal);
    assert.equal(useViewerStore.getState().undoStacks.get(MODEL)!.length, stack);
    state.undo(MODEL);
    await settleRemesh();
    assert.deepEqual(await rows(), before, 'One Undo removes the complete aggregate');
    assert.ok(!meshes().some(mesh => globals.includes(mesh.expressId)));
    useViewerStore.getState().redo(MODEL);
    await settleRemesh();
    assert.deepEqual(await rows(), created);
    assert.deepEqual(meshes().map(mesh => ({ id: mesh.expressId, positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) })), native);
    const grid = addGrid(MODEL, 42, { UAxes: [{ Tag: 'U', Start: [0, 0], End: [4, 0] }], VAxes: [{ Tag: 'V', Start: [2, -2], End: [2, 2] }] });
    const withGrid = await rows(), axes = views.get(MODEL)!.getNewEntities().filter(e => e.type === 'IfcGridAxis').map(e => e.expressId);
    assert.equal(axes.length, 2);
    const column = addColumn(MODEL, 42, { Position: [2, 0, 0], Profile: { Type: 'Circle', Radius: .2 }, Height: 3 }, { GridId: grid.expressId, IntersectingAxes: [axes[0], axes[1]] });
    await settleRemesh();
    const columnGlobal = toGlobalIdFromModels(useViewerStore.getState().models, MODEL, column.expressId);
    assert.ok(meshes().some(mesh => mesh.expressId === columnGlobal && mesh.indices.length > 0));
    useViewerStore.getState().undo(MODEL);
    await settleRemesh();
    assert.deepEqual(await rows(), withGrid, 'One Undo removes the column and all binding helpers');
    useViewerStore.getState().undo(MODEL);
    assert.deepEqual(await rows(), created, 'Grid Undo retains the earlier curtain wall');
    assert.equal(useViewerStore.getState().models.get('peer')?.geometryResult, peerGeometry);
    assert.deepEqual(views.get('peer')?.getMutations() ?? [], []);
  } finally { api.free(); }
});
