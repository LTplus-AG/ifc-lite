/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { clearStoreyRoomsCache } from '@/lib/rooms/storey-rooms';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import '@/lib/commands/modeling/builtin';
import { getModelingCommand } from '@/lib/commands/modeling/registry';
import { PLAN_MOVE, readPlanMoveTarget } from '@/lib/commands/modeling/commands/plan-move';
import { runTransaction } from '@/lib/commands/modeling/transaction';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';

import { MODEL, requests, seedNativeSdkModel as seed, settle, nativeSdkMeshes as meshes, nativeSdkUndoDepth as depth } from '@/test/native-sdk-model';

afterEach(() => {
  setRemeshClientFactory(null);
  clearModelLayouts(MODEL);
  clearStoreyRoomsCache();
});

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


it('plan.move carries joined walls through the shared physical writer and one Undo restores native geometry (#6232)', async t => {
  if (!ensureRoomWasm(t)) return;
  const { adapter, view } = await seed();
  const first = adapter.addWall(MODEL, 42, { Start: [20,20,0], End: [24,20,0], Thickness: .2, Height: 3 });
  const second = adapter.addWall(MODEL, 42, { Start: [24,20,0], End: [24,23,0], Thickness: .2, Height: 3 });
  adapter.joinWalls(MODEL, first.expressId, second.expressId);
  await settle();
  // Undo restores deleted auxiliary records by id; Map insertion order is not the graph contract.
  const graph = () => structuredClone([...view.getNewEntities()].sort((a, b) => a.expressId - b.expressId));
  const before = graph(), undo = depth();
  const secondBefore = meshes().filter(mesh => mesh.expressId === second.expressId).map(mesh => Array.from(mesh.positions));
  const plane = buildStoreyWorkplane(useViewerStore.getState(), MODEL, 42, 0);
  assert.ok(isWorkplane(plane));
  const target = readPlanMoveTarget(useViewerStore.getState(), MODEL, first.expressId);
  assert.ok(target);
  const command = getModelingCommand(PLAN_MOVE.id);
  assert.ok(command);
  const outcome = runTransaction(useViewerStore, command, { target, base: [20,20], to: [21,20] },
    { get: useViewerStore.getState, modelId: MODEL, storeyId: 42, workplane: plane });
  assert.ok(outcome.ok, outcome.ok ? 'plan.move committed' : outcome.reason);
  const endpoints = useViewerStore.getState().readWallEndpoints(MODEL, second.expressId);
  assert.ok(endpoints);
  assert.deepEqual(endpoints.start.slice(0, 2), [25,20], 'the adjacent joined endpoint follows the moved wall');
  assert.ok(outcome.result.remesh.includes(second.expressId), 'the joined neighbour is remeshed in the same transaction');
  await settle();
  assert.notDeepEqual(meshes().filter(mesh => mesh.expressId === second.expressId).map(mesh => Array.from(mesh.positions)), secondBefore);
  const state = useViewerStore.getState();
  const writes = state.undoStacks.get(MODEL)!.slice(undo);
  assert.equal(new Set(writes.map(mutation => state.mutationBatchTags.get(mutation.id))).size, 1);
  state.undo(MODEL);
  await settle();
  assert.equal(depth(), undo);
  assert.deepEqual(graph(), before);
  assert.deepEqual(meshes().filter(mesh => mesh.expressId === second.expressId).map(mesh => Array.from(mesh.positions)), secondBefore);
});
