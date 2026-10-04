/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { MODEL, seedNativeSdkModel, settle, nativeSdkMeshes, nativeSdkUndoDepth } from '@/test/native-sdk-model';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { clearStoreyRoomsCache } from '@/lib/rooms/storey-rooms';
import { storeyBoxes, edgeOf } from '@/lib/commands/modeling/align-boxes';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import '@/lib/commands/modeling/builtin';
import { getModelingCommand } from '@/lib/commands/modeling/registry';
import { runTransaction } from '@/lib/commands/modeling/transaction';

afterEach(() => {
  setRemeshClientFactory(null);
  clearModelLayouts(MODEL);
  clearStoreyRoomsCache();
});

it('public viewer SDK Align measures actual Bonsai-native geometry and one Undo restores different target shifts (#6232)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { adapter, view } = await seedNativeSdkModel();
  const column = (x: number, y: number, width: number) => adapter.addColumn(MODEL, 42,
    { Position: [x,y,0], Width: width, Depth: .4, Height: 3 });
  const reference = column(20,20,.8), first = column(24,21,.4), second = column(28,22,.6);
  await settle();
  const plane = buildStoreyWorkplane(useViewerStore.getState(), MODEL, 42, 0);
  assert.ok(isWorkplane(plane));
  const boxes = () => storeyBoxes(useViewerStore.getState(), MODEL, 42, plane);
  const original = boxes(), referenceBox = original.get(reference.expressId);
  assert.ok(referenceBox);
  const ids = new Set([reference.expressId, first.expressId, second.expressId]);
  const geometry = () => nativeSdkMeshes().filter(mesh => ids.has(mesh.expressId))
    .map(mesh => ({ id: mesh.expressId, origin: mesh.origin, positions: Array.from(mesh.positions),
      indices: Array.from(mesh.indices), normals: mesh.normals ? Array.from(mesh.normals) : [] }))
    .sort((a, b) => a.id - b.id);
  const graph = () => structuredClone([...view.getNewEntities()].sort((a, b) => a.expressId - b.expressId));
  const before = graph(), nativeBefore = geometry(), undo = nativeSdkUndoDepth();
  const aligned = await adapter.alignElements!(MODEL, reference.expressId, [first.expressId, second.expressId], 'left');
  await settle();
  assert.ok(aligned.some(ref => ref.expressId === first.expressId));
  assert.ok(aligned.some(ref => ref.expressId === second.expressId));
  const after = boxes();
  assert.deepEqual(after.get(reference.expressId), referenceBox, 'the reference is not moved');
  for (const ref of [first, second]) {
    const actual = after.get(ref.expressId), old = original.get(ref.expressId);
    assert.ok(actual && old);
    assert.ok(Math.abs(edgeOf('left', actual) - edgeOf('left', referenceBox)) < 1e-4,
      'actual remeshed target edges agree with the unchanged reference');
    assert.ok(Math.abs(actual.min[1] - old.min[1]) < 1e-4, 'the orthogonal position is retained');
  }
  assert.notDeepEqual(geometry(), nativeBefore);
  const state = useViewerStore.getState(), writes = state.undoStacks.get(MODEL)!.slice(undo);
  assert.ok(writes.length > 0);
  assert.equal(new Set(writes.map(mutation => state.mutationBatchTags.get(mutation.id))).size, 1,
    'both different shifts are one actual viewer undo group');
  state.undo(MODEL);
  await settle();
  assert.equal(nativeSdkUndoDepth(), undo);
  assert.deepEqual(graph(), before);
  assert.deepEqual(geometry(), nativeBefore);
});

it('registered viewer Align carries a joined neighbour through its viewer hook and one Undo restores native geometry (#6232, review4172992022)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { adapter, view } = await seedNativeSdkModel();
  const reference = adapter.addColumn(MODEL, 42, { Position: [10,20,0], Width: .4, Depth: .6, Height: 3 });
  const target = adapter.addWall(MODEL, 42, { Start: [20,20,0], End: [24,20,0], Thickness: .2, Height: 3 });
  const neighbour = adapter.addWall(MODEL, 42, { Start: [24,20,0], End: [24,24,0], Thickness: .2, Height: 3 });
  const other = adapter.addColumn(MODEL, 42, { Position: [30,30,0], Width: .8, Depth: .4, Height: 3 });
  adapter.joinWalls(MODEL, target.expressId, neighbour.expressId);
  await settle();
  const plane = buildStoreyWorkplane(useViewerStore.getState(), MODEL, 42, 0);
  assert.ok(isWorkplane(plane));
  const boxes = () => storeyBoxes(useViewerStore.getState(), MODEL, 42, plane);
  const initial = boxes(), fixed = initial.get(reference.expressId), wall = initial.get(target.expressId);
  assert.ok(fixed && wall);
  const shift = fixed.min[0] - wall.min[0];
  const graph = () => structuredClone([...view.getNewEntities()].sort((a, b) => a.expressId - b.expressId));
  const geometry = () => nativeSdkMeshes().map(mesh => ({ id: mesh.expressId, origin: mesh.origin,
    positions: Array.from(mesh.positions), indices: Array.from(mesh.indices), normals: Array.from(mesh.normals), color: mesh.color }))
    .sort((a, b) => a.id - b.id);
  const before = graph(), nativeBefore = geometry(), undo = nativeSdkUndoDepth();
  const command = getModelingCommand('element.align');
  assert.ok(command);
  const result = runTransaction(useViewerStore, command,
    { boxes: initial, reference: reference.expressId, targets: [target.expressId, other.expressId], mode: 'left', hover: null },
    { get: useViewerStore.getState, modelId: MODEL, storeyId: 42, workplane: plane });
  assert.ok(result.ok, result.ok ? 'registered Align committed' : result.reason);
  assert.ok(result.result.remesh.includes(neighbour.expressId), 'the viewer hook includes the neighbour in the same remesh');
  const endpoints = useViewerStore.getState().readWallEndpoints(MODEL, neighbour.expressId);
  assert.ok(endpoints);
  assert.ok(Math.abs(endpoints.start[0] - (24 + shift)) < 1e-4, 'the joined endpoint follows this target-specific shift');
  assert.ok(Math.abs(endpoints.start[1] - 20) < 1e-4);
  assert.deepEqual(endpoints.end.slice(0, 2), [24,24], 'the unjoined far endpoint remains fixed');
  await settle();
  const after = boxes();
  assert.deepEqual(after.get(reference.expressId), fixed);
  for (const id of [target.expressId, other.expressId]) {
    const box = after.get(id);
    assert.ok(box && Math.abs(box.min[0] - fixed.min[0]) < 1e-4);
  }
  const own = (snapshot: ReturnType<typeof geometry>) => snapshot.filter(mesh => mesh.id === neighbour.expressId);
  assert.ok(own(geometry()).some(mesh => mesh.indices.length > 3), 'actual native neighbour geometry is displayed');
  assert.notDeepEqual(own(geometry()), own(nativeBefore), 'the neighbour was genuinely remeshed');
  const state = useViewerStore.getState(), writes = state.undoStacks.get(MODEL)!.slice(undo);
  assert.ok(writes.length > 0);
  assert.equal(new Set(writes.map(mutation => state.mutationBatchTags.get(mutation.id))).size, 1);
  state.undo(MODEL);
  await settle();
  assert.equal(nativeSdkUndoDepth(), undo);
  assert.deepEqual(graph(), before);
  assert.deepEqual(geometry(), nativeBefore);
});
