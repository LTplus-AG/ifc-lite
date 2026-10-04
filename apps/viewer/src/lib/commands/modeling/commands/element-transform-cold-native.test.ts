/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { readFileSync } from 'node:fs';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { IfcAPI } from '@ifc-lite/wasm';
import { CoordinateHandler, type GeometryResult } from '@ifc-lite/geometry';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { applyRemeshConfig, remeshOnApi, styleWireOnApi } from '../../../../../../../packages/geometry/src/remesh/remesh-core.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { configureMutationView } from '@/utils/configureMutationView';
import { toGlobalIdFromModels } from '@/store/globalId';
import { planSelectionTransform } from '@/lib/element-transform/commit';
import { buildStoreyWorkplane, isWorkplane } from '../workplane.js';
import { beginCommandRuntime, commandPointerMove, endCommandRuntime, getCommandRuntime } from '../runtime.js';
import { getModelingCommand } from '../registry.js';
import '../builtin.js';
import { alignMoves, type AlignGesture } from '../align-gesture.js';
import type { ElementMoveGesture } from './element-move-geometry.js';
import type { ElementRotateGesture } from './element-rotate-geometry.js';

const MODEL = 'cold';
const sample = new URL('../../../../../public/samples/hello-wall.ifc', import.meta.url);
afterEach(endCommandRuntime);

/** Parsed Bonsai source and actual native meshes, before any editor/view has
 * been registered. No previously edited overlay is discarded to make it cold. */
async function coldModel(federated: boolean) {
  const bytes = readFileSync(sample);
  const parse = () => new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  const store = await parse(), peer = federated ? await parse() : null;
  const baseline = new MutablePropertyView(store.properties ?? null, MODEL);
  configureMutationView(baseline, store);
  new StoreEditor(store, baseline); // Establish the source watermark without allocating.
  const api = new IfcAPI();
  let geometry: GeometryResult;
  try {
    applyRemeshConfig(api, { mergeLayers: false, tessellationQuality: null, skipSmallCuts: false, rectParamFastPath: true });
    const frame = { x: 0, y: 0, z: 0, needsShift: false };
    const result = remeshOnApi(api, { buffer: bytes, targets: Uint32Array.of(1222,1262,1407), frame, ...styleWireOnApi(api, bytes) });
    const bounds = new CoordinateHandler().calculateBounds(result.meshes);
    geometry = { meshes: result.meshes, totalTriangles: result.meshes.reduce((n,m) => n + m.indices.length / 3, 0), totalVertices: result.meshes.reduce((n,m) => n + m.positions.length / 3, 0), coordinateInfo: { wasmRtcFrame: frame, originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
  } finally { api.free(); }
  const model = { ...fixtureModel(MODEL, { idOffset: federated ? 1_000_000 : 0 }), ifcDataStore: store, maxExpressId: baseline.peekNextExpressId() - 1, geometryResult: geometry };
  const models = fixtureModels(model, ...(peer ? [{ ...fixtureModel('peer', { idOffset: 2_000_000 }), ifcDataStore: peer, maxExpressId: baseline.peekNextExpressId() - 1 }] : []));
  // Use the canonical federation conversion for every displayed mesh/selection.
  geometry.meshes = geometry.meshes.map(mesh => ({ ...mesh, expressId: toGlobalIdFromModels(models.models, MODEL, mesh.expressId) }));
  useViewerStore.setState({ ...models, geometryResult: geometry, mutationViews: new Map(), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), removedNewEntities: new Map(), removedMeshes: new Map(), pendingMeshRemovals: null, pendingMeshEdits: null, mutationVersion: 0, editEnabled: true, collabRoomId: null, canCollabEdit: () => true });
  return { store, peer, geometry, next: baseline.peekNextExpressId(), source: store.source.slice(0, store.source.byteLength) };
}

for (const federated of [false, true]) for (const id of ['element.align', 'element.move', 'element.rotate']) {
  it(`${id} cold Bonsai host/child preview and cancellation preserve graph/history in ${federated ? 'N' : '1'} model(s) (#6232, #6761 review4176580364)`, async t => {
    if (!ensureRoomWasm(t)) return;
    const fixture = await coldModel(federated);
    const state = useViewerStore.getState();
    const global = (expressId: number) => toGlobalIdFromModels(state.models, MODEL, expressId);
    const selected = id === 'element.align' ? [1222,1407,1262] : [1222,1407];
    useViewerStore.setState({ selectedEntityIds: new Set(selected.map(global)), selectedEntityId: global(selected.at(-1)!) });
    const plane = buildStoreyWorkplane(useViewerStore.getState(), MODEL, 42, 0);
    assert.ok(isWorkplane(plane));
    assert.equal(state.mutationViews.size, 0);
    assert.ok(fixture.geometry.meshes.every(mesh => mesh.positions.length > 0 && mesh.indices.length > 0), 'all preview inputs are native meshes');
    const command = getModelingCommand(id);
    assert.ok(command);
    beginCommandRuntime(command, { get: useViewerStore.getState, modelId: MODEL, storeyId: 42, workplane: plane }, useViewerStore, { onPhase: () => {}, onExit: endCommandRuntime });
    if (id === 'element.align') {
      const gesture = getCommandRuntime().gesture as AlignGesture;
      assert.ok(gesture.targets.includes(1222) && gesture.targets.includes(1407), JSON.stringify({ targets: gesture.targets, boxes: [...gesture.boxes.keys()], meshes: fixture.geometry.meshes.map(m => m.expressId) }));
      assert.ok(gesture.carried?.includes(1407), 'selected filling is governed by its host before the first edit');
      assert.deepEqual(alignMoves(gesture).map(move => move.id), [1222], 'the filling is never shifted independently in preview');
    } else {
      const gesture = getCommandRuntime().gesture as ElementMoveGesture | ElementRotateGesture;
      assert.ok(gesture.selection, 'Move/Rotate can plan a cold selection');
      assert.equal(gesture.selection.refusal, null);
      assert.deepEqual(new Set(gesture.selection.movedGlobalIds), new Set([1222,1299,1262,1443,1407].map(global)));
    }
    const live = useViewerStore.getState();
    const view = live.mutationViews.get(MODEL);
    assert.ok(view);
    // Init entered with this empty captured map; registration replaces it.
    // The shared planner must use its returned edit target, not that old map.
    assert.equal(state.mutationViews.size, 0);
    const plan = planSelectionTransform(live, MODEL, [1222,1407]);
    assert.ok(plan && plan.carried.includes(1407));
    const editor = live.storeEditors.get(MODEL);
    commandPointerMove({ local: [8,4], render: plane.localToRender([8,4,0]), winner: null, guides: [], locked: false });
    endCommandRuntime();
    assert.equal(getCommandRuntime().command, null);
    assert.equal(useViewerStore.getState().mutationViews.get(MODEL), view, 'cancel retains the empty configured edit view');
    assert.equal(useViewerStore.getState().storeEditors.get(MODEL), editor);
    assert.deepEqual(view.getMutations(), []);
    assert.deepEqual(view.getNewEntities(), []);
    assert.equal(view.hasChanges(), false);
    assert.equal(view.getMutationRevision(), 0);
    assert.equal(view.peekNextExpressId(), fixture.next);
    assert.equal(useViewerStore.getState().mutationVersion, 0);
    assert.deepEqual([...useViewerStore.getState().undoStacks], []);
    assert.deepEqual([...useViewerStore.getState().redoStacks], []);
    assert.deepEqual(fixture.store.source.slice(0, fixture.store.source.byteLength), fixture.source);
    assert.equal(useViewerStore.getState().models.get(MODEL)?.geometryResult, fixture.geometry);
    if (fixture.peer) {
      assert.equal(useViewerStore.getState().models.get('peer')?.ifcDataStore, fixture.peer);
      assert.deepEqual(fixture.peer.source.slice(0, fixture.peer.source.byteLength), fixture.source);
      assert.equal(useViewerStore.getState().mutationViews.has('peer'), false);
      assert.equal(useViewerStore.getState().storeEditors.has('peer'), false);
    }
  });
}
