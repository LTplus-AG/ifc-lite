/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { IfcParser, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { createCollabSession, createEntity, deleteEntity, setAttribute, setPropertyValue, getPropertyValue, deletePropertyValue } from '@ifc-lite/collab';
import { useViewerStore } from '@/store';
import { bindRoomPropertyApi } from '@/lib/collab/room-property-api';
import { registerStoreSlot, registerEntityPath, pathForGuid, pathForEntity } from '@/lib/collab/entity-paths';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { assertSameNativeIfcGraph } from '@/test/native-ifc-graph';
import { MODEL, seedNativeSdkModel, settle, nativeSdkMeshes } from '@/test/native-sdk-model';
import { disposeRemeshClient, setRemeshClientFactory } from '@/lib/remesh/remesh-service';

// #9453: a real publication failure must leave the shared building whole,
// surface a notice, and never damage the previous edit's native Undo result.
for (const failAt of [1, 3]) it(`roof room failure after ${failAt} writes preserves native rooms and Undo (#9453)`, async t => {
  const { store, view, adapter } = await seedNativeSdkModel();
  t.after(() => { disposeRemeshClient(); setRemeshClientFactory(null); });
  bindRoomPropertyApi({ getPropertyValue, setPropertyValue, deletePropertyValue });
  const session = await createCollabSession({ roomId: 'Roof review room', user: { id: 'owner', name: 'Owner' }, provider: 'memory' });
  t.after(() => session.dispose());
  const slot = { slotId: 'm0', pathPrefix: '/m0' };
  registerStoreSlot(store, slot);
  const restoredWithoutGuid: number[] = [];
  useViewerStore.setState({ collabRoomId: session.roomId, collabSession: session, collabGeometryNotice: null,
    collabRoomModels: new Map([[MODEL, slot]]),
    mirrorEntityCreate: (_model, id, type, guid) => {
      const previousPath = pathForEntity(store, id);
      if (!guid) { assert.ok(previousPath, 'Undo retains the original expressId and registered room path'); restoredWithoutGuid.push(id); }
      const path = previousPath ?? (guid ? pathForGuid(store, guid) : null);
      assert.ok(path);
      session.transact(() => createEntity(session.doc, path, { ifcClass: type }));
      registerEntityPath(store, id, path);
    },
    mirrorEntityRemove: (_model, id) => {
      const path = pathForEntity(store, id);
      if (path) session.transact(() => deleteEntity(session.doc, path));
      // Match production: a tombstone retains identity for restoring the same id.
    },
    mirrorAttributeEdit: (_model, id, name, value) => {
      const path = pathForEntity(store, id); assert.ok(path);
      session.transact(() => setAttribute(session.doc, path, name, value));
    },
    mirrorPropertyEdit: (_model, id, pset, name, value) => {
      const path = pathForEntity(store, id); assert.ok(path);
      assert.ok(typeof value === 'string' || typeof value === 'number');
      session.transact(() => setPropertyValue(session.doc, path, pset, name,
        { type: typeof value === 'number' ? 'IfcReal' : 'IfcText', value }));
    },
  });
  const space = adapter.addSpace(MODEL, 42, { Position: [0,0,0], Width: 4, Depth: 3, Height: 3, Name: 'Room under roof' });
  const roof = adapter.addRoof(MODEL, 42, { Position: [0,0,3], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: Array(4).fill(Math.PI / 6) });
  await settle();
  const bytes = () => editedModelBytes(store, view);
  const mesh = (id: number) => structuredClone(nativeSdkMeshes().filter(part => part.expressId === id));
  const quantities = async () => {
    const source = bytes();
    const parsed = await new IfcParser().parseColumnar(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength), { disableWorkerScan: true });
    return extractQuantitiesOnDemand(parsed, space.expressId);
  };
  const before = bytes(), spaceMesh = mesh(space.expressId), roofMesh = mesh(roof.expressId), spaceQuantities = await quantities();
  assert.ok(spaceMesh.length > 0 && roofMesh.length > 0, 'the real native mesher produced both roof and room');
  assert.ok(spaceQuantities.length > 0, 'the exported room has real quantities');
  const edit = adapter.editRoof; assert.ok(edit);
  edit(roof, { EdgeSlopes: [Math.PI/6,0,Math.PI/6,0] });
  await settle();
  const edited = bytes(), peerBefore = session.snapshot().data;
  const historyDepth = useViewerStore.getState().undoStacks.get(MODEL)?.length;
  const original = useViewerStore.getState().mirrorPropertyEdit;
  let writes = 0;
  useViewerStore.setState({ mirrorPropertyEdit: (...args) => { original(...args); if (++writes === failAt) throw new Error('Injected roof room publication failure'); } });
  t.after(() => useViewerStore.setState({ mirrorPropertyEdit: original }));
  assert.throws(() => edit(roof, { Overhang: .5 }), /Injected roof room publication failure/);
  assert.equal(writes, failAt, 'failure followed actual room metadata writes');
  assert.deepEqual(session.snapshot().data, peerBefore, 'no partial roof definition or room graph survives');
  await assertSameNativeIfcGraph(bytes(), edited, 'a refused publication commits no native edit');
  assert.deepEqual(mesh(space.expressId), spaceMesh, 'room mesh stays consistent during refusal');
  assert.deepEqual(await quantities(), spaceQuantities, 'room quantities stay consistent during refusal');
  assert.equal(useViewerStore.getState().undoStacks.get(MODEL)?.length, historyDepth, 'refusal adds no Undo step');
  const notice = useViewerStore.getState().consumeCollabGeometryNotice();
  assert.match(notice ?? '', /Roof review room/);
  assert.match(notice ?? '', /roof|Roof/);
  useViewerStore.setState({ mirrorPropertyEdit: original });
  useViewerStore.getState().undo(MODEL);
  await settle();
  await assertSameNativeIfcGraph(bytes(), before, 'Undo restores the complete previous roof and room IFC graph');
  assert.deepEqual(mesh(roof.expressId), roofMesh, 'Undo restores actual native roof meshes');
  assert.deepEqual(mesh(space.expressId), spaceMesh, 'Undo preserves actual native room meshes');
  assert.deepEqual(await quantities(), spaceQuantities, 'Undo preserves exported room quantities');
  assert.ok(restoredWithoutGuid.length > 0, 'Undo exercised restored geometry identities without GUIDs');
});
