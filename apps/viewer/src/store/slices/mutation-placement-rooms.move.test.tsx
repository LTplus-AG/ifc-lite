/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import { IfcAPI } from '@ifc-lite/wasm';
import { StepExporter } from '@ifc-lite/export';
import { remeshOnApi, styleWireOnApi } from '../../../../../packages/geometry/src/remesh/remesh-core.js';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { configureMutationView } from '@/utils/configureMutationView';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { advance } from '@/test/render';
import { requestRemesh, setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { resolvePlacementChain } from '@/lib/placement-edit';
import { modelEditTarget } from './mutation-modelling-records';
import { moveWithGeneratedRooms } from './mutation-placement-rooms';
import { setTopConstraintInStore } from '../../../../../packages/create/src/in-store/storey/storey-top-constraint.js';

async function reopenedRooms() {
  await seedModelingSession();
  useViewerStore.getState().mutationViews.get(MODEL_ID)!.deleteEntity(130);
  const walls = ([[0, 0, 10, 0], [10, 0, 10, 8], [10, 8, 0, 8], [0, 8, 0, 0], [5, 0, 5, 8]])
    .map(([x, y, endX, endY]) => {
      const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY,
        { Start: [x, y, 0], End: [endX, endY, 0], Height: 3, Thickness: .23 });
      assert.ok('expressId' in wall);
      return wall.expressId;
    });
  const result = useViewerStore.getState().generateSpacesFromWalls(MODEL_ID, STOREY);
  assert.ok(!('error' in result));
  const rooms = result.emitted.map(room => room.result.spaceId);
  assert.equal(rooms.length, 2);
  const state = useViewerStore.getState();
  const bytes = new StepExporter(state.models.get(MODEL_ID)!.ifcDataStore!, state.mutationViews.get(MODEL_ID)!)
    .export({ schema: 'IFC4', applyMutations: true }).content;
  const view = await seedModelingSession({ step: new TextDecoder().decode(bytes) });
  const fresh = useViewerStore.getState(), model = fresh.models.get(MODEL_ID)!;
  configureMutationView(view, model.ifcDataStore!);
  const geometryResult = { ...model.geometryResult!, coordinateInfo: {
    ...model.geometryResult!.coordinateInfo!, wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false },
  } };
  useViewerStore.setState({ models: new Map([[MODEL_ID, { ...model, geometryResult }]]), geometryResult,
    pendingMeshTranslations: null, mutationMeshTranslations: new Map() });
  const areas = () => rooms.map(id => view.getQuantitiesForEntity(id)
    .find(set => set.name === 'Qto_SpaceBaseQuantities')?.quantities.find(q => q.name === 'NetFloorArea')?.value);
  return { wall: walls[4], rooms, areas };
}

for (const mode of ['helper', 'position', 'translate', 'drag'] as const) {
  it(`#9296 reopened room wall ${mode} retains one batch and move presentation`, async t => {
    if (!ensureRoomWasm(t)) return;
    const { wall, rooms, areas } = await reopenedRooms();
    const before = areas(), api = new IfcAPI(), remeshed: number[] = [];
    const mirrorCalls: { modelId: string; id: number; delta: [number, number, number] }[] = [];
    const mirror = useViewerStore.getState().mirrorPlacementEdit;
    try {
      setRemeshClientFactory(async () => ({
        alive: true, dispose: () => {}, setConfig: () => {},
        styleWire: async bytes => styleWireOnApi(api, bytes),
        remesh: async request => {
          remeshed.push(...request.targets);
          return remeshOnApi(api, request);
        },
      }));
      useViewerStore.setState({ mirrorPlacementEdit: (modelId, id, delta, yaw) => {
        mirrorCalls.push({ modelId, id, delta });
        mirror(modelId, id, delta, yaw);
      } });
      assert.equal((await requestRemesh(useViewerStore.getState, MODEL_ID, [wall, ...rooms], 'created')).status, 'applied');
      remeshed.length = 0;
      const priorHistory = useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
      if (mode === 'helper') {
        const target = modelEditTarget(useViewerStore.getState(), MODEL_ID)!;
        const chain = resolvePlacementChain(target.dataStore, target.view, target.editor, wall)!;
        const updated = moveWithGeneratedRooms(useViewerStore, MODEL_ID, wall, chain.cartesianPointId, [6, 0, 0]);
        assert.ok(updated);
        assert.ok('batch' in updated, 'the committed room batch is returned to presentation');
        const written = useViewerStore.getState().undoStacks.get(MODEL_ID)!.slice(priorHistory);
        assert.ok(written.length > 1, 'wall and generated room writes were committed');
        assert.deepEqual(new Set(written.map(m => useViewerStore.getState().mutationBatchTags.get(m.id))), new Set([updated.batch]));
      } else {
        const move = mode === 'position'
          ? useViewerStore.getState().setEntityPosition(MODEL_ID, wall, [6, 0, 0])
          : useViewerStore.getState().translateEntity(MODEL_ID, wall, [1, 0, 0], mode === 'drag' ? 'room-wall-drag' : undefined);
        assert.ok(move.ok);
        const state = useViewerStore.getState(), globalId = toGlobalIdFromModels(state.models, MODEL_ID, wall);
        assert.deepEqual(state.pendingMeshTranslations?.get(globalId), [1, 0, -0]);
        assert.deepEqual(mirrorCalls, [{ modelId: MODEL_ID, id: wall, delta: [1, 0, 0] }]);
        const tags = [...state.mutationMeshTranslations].filter(([, tag]) => tag.globalId === globalId);
        assert.equal(tags.length, 1, 'undo retains the wall renderer translation');
        const batch = state.mutationBatchTags.get(tags[0][0]);
        assert.ok(batch);
        if (mode === 'drag') assert.equal(batch, 'room-wall-drag');
        const written = state.undoStacks.get(MODEL_ID)!.slice(priorHistory);
        assert.deepEqual(new Set(written.map(m => state.mutationBatchTags.get(m.id))), new Set([batch]));
      }
      await advance(30);
      assert.notDeepEqual(areas(), before);
      assert.ok(rooms.every(id => remeshed.includes(id)), 'actual room meshes regenerate after the wall move');
      const meshes = useViewerStore.getState().models.get(MODEL_ID)!.geometryResult!.meshes;
      assert.ok(rooms.every(id => meshes.some(mesh => mesh.expressId === toGlobalIdFromModels(useViewerStore.getState().models, MODEL_ID, id))));
      act(() => useViewerStore.getState().undo(MODEL_ID));
      await advance(30);
      assert.equal(useViewerStore.getState().readEntityPosition(MODEL_ID, wall)![0], 5);
      assert.deepEqual(areas(), before, 'one undo restores wall placement and both room areas');
      assert.equal(useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0, priorHistory);
      act(() => useViewerStore.getState().redo(MODEL_ID));
      await advance(30);
      assert.equal(useViewerStore.getState().readEntityPosition(MODEL_ID, wall)![0], 6);
      assert.notDeepEqual(areas(), before);
    } finally {
      useViewerStore.setState({ mirrorPlacementEdit: mirror });
      setRemeshClientFactory(null);
      api.free();
    }
  });
}

it('#9296 a slab-attached room wall updates its generated rooms in the same undo step', async t => {
  if (!ensureRoomWasm(t)) return;
  const { wall, rooms, areas } = await reopenedRooms();
  const api = new IfcAPI();
  try {
    setRemeshClientFactory(async () => ({
      alive: true, dispose: () => {}, setConfig: () => {},
      styleWire: async bytes => styleWireOnApi(api, bytes),
      remesh: async request => remeshOnApi(api, request),
    }));
    const slab = useViewerStore.getState().addSlab(MODEL_ID, STOREY,
      { Position: [-1, -1, 3.3], Width: 12, Depth: 10, Thickness: .3, ExtrudedDirection: [0, 0, -1] });
    assert.ok('expressId' in slab);
    const target = modelEditTarget(useViewerStore.getState(), MODEL_ID)!;
    setTopConstraintInStore(target.dataStore, target.editor, wall, { kind: 'slab', slabId: slab.expressId });
    const before = areas(), priorHistory = useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
    const move = useViewerStore.getState().translateEntity(MODEL_ID, wall, [1, 0, 0]);
    assert.ok(move.ok, move.ok ? '' : move.reason);
    await advance(30);
    assert.notDeepEqual(areas(), before, 'the rooms follow the attached wall');
    const written = useViewerStore.getState().undoStacks.get(MODEL_ID)!.slice(priorHistory);
    assert.equal(new Set(written.map(m => useViewerStore.getState().mutationBatchTags.get(m.id))).size, 1, 'wall and rooms are one undo step');
    assert.ok(rooms.length > 0);
    act(() => useViewerStore.getState().undo(MODEL_ID));
    await advance(30);
    assert.deepEqual(areas(), before, 'one undo restores the wall and both rooms');
  } finally {
    setRemeshClientFactory(null);
    api.free();
  }
});
