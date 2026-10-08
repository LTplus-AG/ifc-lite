/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: ordinary creation retains the live placement/owner history
 * contract; free door/window delegation reads the same effective view. */
import '@/test/setup-dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { placedBodyExtent, resolveSpatialAnchor } from '@ifc-lite/create';
import { StepExporter } from '@ifc-lite/export';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { installScriptedMesher, settleRemesh } from '@/test/scripted-mesher';
import { createStoreAdapter } from './store-adapter.js';

const SAMPLE = new URL('../../../public/samples/hello-wall.ifc', import.meta.url);
const WASM = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const STOREY = 42;
afterEach(() => useViewerStore.setState({ collabRoomId: null, collabRoomModels: new Map() }));

function physicalBounds(bytes: Uint8Array, ids: readonly number[]) {
  initSync({ module: readFileSync(WASM) });
  const api = new IfcAPI();
  const bounds = new Map(ids.map(id => [id, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], vertices: 0 }]));
  try {
    const pre = api.buildPrePassOnce(bytes);
    try {
      const offset = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
      const meshes = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, offset[0], offset[1], offset[2], pre.needsShift,
        pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
      try {
        for (let i = 0; i < meshes.length; i++) {
          const mesh = meshes.get(i);
          if (!mesh) continue;
          try {
            const target = bounds.get(mesh.expressId);
            if (!target) continue;
            const positions = mesh.positions, origin = mesh.origin;
            for (let j = 0; j < positions.length; j += 3) {
              const point = [origin[0] + positions[j], -(origin[2] + positions[j + 2]), origin[1] + positions[j + 1]];
              for (let axis = 0; axis < 3; axis++) {
                const value = point[axis] + (pre.needsShift ? offset[axis] : 0);
                target.min[axis] = Math.min(target.min[axis], value);
                target.max[axis] = Math.max(target.max[axis], value);
              }
              target.vertices++;
            }
          } finally { mesh.free(); }
        }
      } finally { meshes.free(); }
    } finally { api.clearPrePassCache(); }
  } finally { api.free(); }
  return bounds;
}

for (const count of [1, 2]) {
  it(`#6232 D5 legacy free fills and ordinary wall follow a live storey placement with ${count} model(s)`,
    { skip: existsSync(WASM) ? false : 'run pnpm build:wasm for native physical placement proof' }, async () => {
    const models: FederatedModel[] = [];
    for (const [index, id] of ['alpha', 'beta'].slice(0, count).entries()) {
      const bytes = readFileSync(SAMPLE);
      const store = await new IfcParser().parseColumnar(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true },
      );
      models.push({ ...fixtureModel(id, { idOffset: index * 1_000_000 }), ifcDataStore: store,
        geometryResult: { meshes: [], totalTriangles: 0, totalVertices: 0,
          coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
            originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
            shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
            wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false } } } });
    }
    const target = models.at(-1)!, modelId = target.id, store = target.ifcDataStore!;
    const views = new Map(models.map(model => [model.id, new MutablePropertyView(model.ifcDataStore!.properties ?? null, model.id)]));
    useViewerStore.setState({ ...fixtureModels(...models), activeModelId: modelId,
      mutationViews: views, storeEditors: new Map(), editEnabled: true,
      collabRoomId: null, collabRoomModels: new Map(), canCollabEdit: () => true,
      undoStacks: new Map(), redoStacks: new Map(), dirtyModels: new Set(), mutationBatchTags: new Map(),
      removedNewEntities: new Map(), removedMeshes: new Map(), pendingMeshRemovals: null,
      pendingMeshEdits: null, mutationVersion: 0,
    });
    const view = views.get(modelId)!, editor = new StoreEditor(store, view);
    useViewerStore.getState().storeEditors.set(modelId, editor);
    const previousOwner = resolveSpatialAnchor(store, STOREY, view).ownerHistoryId;
    const point = editor.addEntity('IfcCartesianPoint', [[10, 20, 2]]).expressId;
    const direction = editor.addEntity('IfcDirection', [[0, 1, 0]]).expressId;
    const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, `#${direction}`]).expressId;
    const placement = editor.addEntity('IfcLocalPlacement', [null, `#${axis}`]).expressId;
    editor.setPositionalAttribute(STOREY, 5, `#${placement}`);
    const exportModel = (index: number) => new StepExporter(models[index].ifcDataStore!, views.get(models[index].id)!)
      .export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-01-01T00:00:00' }).content;
    const peerBefore = count === 2 ? exportModel(0) : null;
    const mesher = installScriptedMesher();
    try {
      const adapter = createStoreAdapter(useViewerStore);
      const door = adapter.addDoor(modelId, STOREY, { Position: [2, 3, 1], Width: .9, Height: 2.1 });
      const window = adapter.addWindow(modelId, STOREY, { Position: [2, 3, 1], Width: 1.2, Height: 1.4 });
      const wall = adapter.addWall(modelId, STOREY, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 3 });
      for (const ref of [door, window, wall]) {
        assert.equal(ref.modelId, modelId);
        const product = view.getNewEntity(ref.expressId)!;
        assert.equal(product.attributes[1], previousOwner === null ? null : `#${previousOwner}`, 'existing anchor default preserved');
        const localPlacement = view.getNewEntity(Number(String(product.attributes[5]).slice(1)))!;
        assert.equal(localPlacement.attributes[0], `#${placement}`, 'binds to the live overlay placement, not source #65');
      }
      const rounded = (point: readonly number[]) => point.map(value => +value.toFixed(6));
      for (const [ref, min, max] of [
        [door, [1.55, 2.975, 1], [2.45, 3.025, 3.1]],
        [window, [1.4, 2.975, 1], [2.6, 3.025, 2.4]],
        [wall, [0, 4.9, 0], [4, 5.1, 3]],
      ] as const) {
        const extent = placedBodyExtent(store, ref.expressId, view);
        assert.ok(extent, 'actual authored IFC graph has a readable body');
        assert.deepEqual(rounded(extent.min), min, 'body bounds in its parent storey placement');
        assert.deepEqual(rounded(extent.max), max);
      }
      const saved = exportModel(count - 1);
      const physical = physicalBounds(saved, [door.expressId, window.expressId, wall.expressId]);
      // Independently expected Z-up world tuples: local points rotated +90°
      // then translated [10,20,2]; native Rust resolves the exported IFC graph.
      for (const [ref, centre, size] of [
        [door, [7, 22, 4.05], [.05, .9, 2.1]],
        [window, [7, 22, 3.7], [.05, 1.2, 1.4]],
        [wall, [5, 22, 3.5], [.2, 4, 3]],
      ] as const) {
        const box = physical.get(ref.expressId)!;
        assert.ok(box.vertices > 0, 'native geometry emits this authored entity');
        for (let axis = 0; axis < 3; axis++) {
          assert.ok(Math.abs((box.min[axis] + box.max[axis]) / 2 - centre[axis]) < 1e-4);
          assert.ok(Math.abs(box.max[axis] - box.min[axis] - size[axis]) < 1e-4);
        }
      }
      const reparsed = await new IfcParser().parseColumnar(saved.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
      for (const ref of [door, window, wall]) assert.equal(reparsed.spatialHierarchy?.elementToStorey.get(ref.expressId), STOREY);
      const history = useViewerStore.getState().undoStacks.get(modelId) ?? [];
      for (const ref of [door, window, wall]) assert.ok(history.some(item => item.type === 'CREATE_ENTITY' && item.entityId === ref.expressId));
      assert.equal(new Set(history.map(item => useViewerStore.getState().mutationBatchTags.get(item.id))).size, 3, 'three complete IFC graph Undo groups');
      if (count === 2) assert.deepEqual(exportModel(0), peerBefore, 'peer export remains unchanged');
      await settleRemesh();
    } finally { mesher.restore(); }
  });
}
