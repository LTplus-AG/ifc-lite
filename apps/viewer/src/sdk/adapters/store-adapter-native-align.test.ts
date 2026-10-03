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
