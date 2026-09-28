/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store.add*` must book what it builds the way the UI's add actions do.
 * The adapter used to stop at the `@ifc-lite/create` builder, so the Flow
 * column-grid example (and any script) "added" columns that existed only in
 * the export overlay: no mesh on screen, no tree entry, no undo, and no
 * `mutationVersion` bump. Runs the real adapter against the real mutation
 * slice over a parsed one-storey model.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import { createMutationSlice } from '../../store/slices/mutationSlice.js';
import { getOrCreateMutationView } from './mutation-view.js';
import { createStoreAdapter } from './store-adapter.js';
import { installScriptedMesher, settleRemesh } from '@/test/scripted-mesher';
import type { StoreApi } from './types.js';

const MODEL = 'm';
const STEP = [
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('storey.ifc','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;', 'DATA;',
  "#1=IFCPROJECT('0proj000000000000000000',$,'P',$,$,$,$,(#7),#9);",
  '#5=IFCCARTESIANPOINT((0.,0.,0.));',
  '#6=IFCAXIS2PLACEMENT3D(#5,$,$);',
  "#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);",
  '#9=IFCUNITASSIGNMENT((#91));',
  '#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
  '#20=IFCLOCALPLACEMENT($,#6);',
  "#30=IFCBUILDINGSTOREY('0storey0000000000000000',$,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);",
  'ENDSEC;', 'END-ISO-10303-21;',
].join('\n');

async function fixture() {
  const bytes = new TextEncoder().encode(STEP);
  const dataStore = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
  const appended: MeshData[] = [];
  const hidden: number[] = [];
  // Loaded through the wasm path, so an add re-meshes in this frame (#6232).
  const geometryResult = { meshes: [], totalTriangles: 0, totalVertices: 0,
    coordinateInfo: { wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false } } };
  let state = {
    models: new Map([[MODEL, { id: MODEL, name: 'storey.ifc', ifcDataStore: dataStore, idOffset: 0, geometryResult }]]),
    activeModelId: MODEL,
    collabRoomId: null,
    collabRoomModels: new Map(),
    canCollabEdit: () => true,
    editEnabled: true,
    // The re-mesh lands through `replaceEntityMeshes`; record what it swaps in.
    replaceEntityMeshes: (_modelId: string, byGlobalId: ReadonlyMap<number, readonly MeshData[]>) => {
      for (const meshes of byGlobalId.values()) appended.push(...meshes);
    },
    hideEntities: (ids: number[]) => { hidden.push(...ids); },
    mirrorEntityCreate: () => {},
    mirrorEntityRemove: () => {},
    mirrorAttributeEdit: () => {},
    mirrorEntityGeometry: () => {},
  } as unknown as ViewerState;
  const setState = (partial: unknown) => {
    const updates = typeof partial === 'function' ? (partial as (s: ViewerState) => Partial<ViewerState>)(state) : partial;
    state = { ...state, ...(updates as Partial<ViewerState>) };
  };
  const store: StoreApi = { getState: () => state, subscribe: () => () => {} };
  state = { ...state, ...createMutationSlice(setState as never, () => state, store as never) };
  assert.ok(getOrCreateMutationView(store, MODEL));
  return { adapter: createStoreAdapter(store), state: () => state, appended, hidden, dataStore };
}

describe('bim.store.add* books what it builds', () => {
  let mesher: ReturnType<typeof installScriptedMesher>;
  beforeEach(() => { mesher = installScriptedMesher(); });
  afterEach(() => mesher.restore());

  it('addColumn injects a mesh, pushes a CREATE_ENTITY undo entry and bumps mutationVersion', async () => {
    const { adapter, state, appended } = await fixture();
    const before = state().mutationVersion;

    const ref = adapter.addColumn(MODEL, 30, { Position: [4, 5, 0], Width: 0.3, Depth: 0.3, Height: 3, GlobalId: '1y$f31PQbViB5eB4WWhgAv' });
    await settleRemesh();

    assert.deepEqual(mesher.requests.map((r) => [...r.targets]), [[ref.expressId]], 'the column is re-meshed from its IFC');
    assert.equal(appended.length, 1, 'the column needs a mesh or it is invisible');
    assert.equal(appended[0].expressId, ref.expressId);
    const stack = state().undoStacks.get(MODEL) ?? [];
    assert.deepEqual(stack.map((m) => [m.type, m.entityId, m.attributeName]), [['CREATE_ENTITY', ref.expressId, 'IFCCOLUMN']]);
    assert.ok(state().dirtyModels.has(MODEL));
    assert.equal(state().mutationVersion, before + 1);
  });

  it('every builder books its element, one undo entry each', async () => {
    const { adapter, state, appended } = await fixture();
    adapter.addWall(MODEL, 30, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    adapter.addBeam(MODEL, 30, { Start: [0, 0, 3], End: [4, 0, 3], Width: 0.2, Height: 0.4 });
    adapter.addSlab(MODEL, 30, { Position: [0, 0, 0], Width: 5, Depth: 5, Thickness: 0.25 });
    await settleRemesh();
    assert.equal(appended.length, 3);
    assert.deepEqual((state().undoStacks.get(MODEL) ?? []).map((m) => m.attributeName), ['IFCWALL', 'IFCBEAM', 'IFCSLAB']);
  });

  it('removeEntity on a store-built element pushes DELETE_ENTITY and stashes the overlay record for undo', async () => {
    const { adapter, state } = await fixture();
    const ref = adapter.addColumn(MODEL, 30, { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 });

    assert.equal(adapter.removeEntity(ref), true);

    const stack = state().undoStacks.get(MODEL) ?? [];
    assert.deepEqual(stack.map((m) => m.type), ['CREATE_ENTITY', 'DELETE_ENTITY']);
    assert.ok(state().removedNewEntities.has(`${MODEL}:${ref.expressId}`), 'undo re-adds the stashed overlay record');
  });

  it('the spatial-tree row follows the element through remove, undo and redo', async () => {
    const { adapter, state, dataStore } = await fixture();
    const hierarchy = dataStore.spatialHierarchy;
    assert.ok(hierarchy, 'the fixture model has a storey');
    const listed = (id: number) => (hierarchy.byStorey.get(30) ?? []).includes(id);
    const ref = adapter.addColumn(MODEL, 30, { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 });
    assert.ok(listed(ref.expressId), 'added: the tree lists it under its storey');

    adapter.removeEntity(ref);
    assert.ok(!listed(ref.expressId), 'removed: no stale row for a deleted element');

    state().undo(MODEL);
    assert.ok(listed(ref.expressId), 'undo of the remove: the row comes back');

    state().undo(MODEL);
    assert.ok(!listed(ref.expressId), 'undo of the add: gone again');

    state().redo(MODEL);
    assert.ok(listed(ref.expressId), 'redo of the add: back');
  });

  it('single-model (legacy) mode books the element too, on the top-level store and geometry', async () => {
    const bytes = new TextEncoder().encode(STEP);
    const dataStore = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
    const geometry: MeshData[] = [];
    let state = {
      models: new Map(),
      activeModelId: null,
      ifcDataStore: dataStore,
      geometryResult: { meshes: geometry, totalTriangles: 0, totalVertices: 0, coordinateInfo: {} },
      collabRoomId: null,
      collabRoomModels: new Map(),
      canCollabEdit: () => true,
      editEnabled: true,
      appendGeometryBatch: () => { throw new Error('legacy mode has no model entry to append onto'); },
      setGeometryResult: (g: { meshes: MeshData[] }) => { geometry.splice(0, geometry.length, ...g.meshes); },
      mirrorEntityCreate: () => {},
    } as unknown as ViewerState;
    const setState = (partial: unknown) => {
      const updates = typeof partial === 'function' ? (partial as (s: ViewerState) => Partial<ViewerState>)(state) : partial;
      state = { ...state, ...(updates as Partial<ViewerState>) };
    };
    const store: StoreApi = { getState: () => state, subscribe: () => () => {} };
    state = { ...state, ...createMutationSlice(setState as never, () => state, store as never) };

    const ref = createStoreAdapter(store).addColumn('default', 30, { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 });

    assert.equal(ref.modelId, '__legacy__');
    // No model entry holds the geometry in legacy mode, so there is nothing for a
    // re-mesh to land in (#6232); the element is still booked below.
    await settleRemesh();
    assert.equal(geometry.length, 0);
    assert.deepEqual((state.undoStacks.get('__legacy__') ?? []).map((m) => m.type), ['CREATE_ENTITY']);
    assert.ok((dataStore.spatialHierarchy?.byStorey.get(30) ?? []).includes(ref.expressId));
  });
});
