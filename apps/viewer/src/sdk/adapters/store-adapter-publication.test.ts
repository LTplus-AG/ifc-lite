/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { createCollabSession, createEntity, deleteEntity, setAttribute } from '@ifc-lite/collab';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { registerStoreSlot, registerEntityPath, unregisterEntityPath, pathForGuid, pathForEntity } from '@/lib/collab/entity-paths';
import { createStoreAdapter } from './store-adapter.js';

const MODEL = 'publication';
async function seed() {
  const bytes = readFileSync(new URL('../../../public/samples/hello-wall.ifc', import.meta.url));
  const data = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  const view = new MutablePropertyView(data.properties, MODEL);
  new StoreEditor(data, view); // Initialize source-aware allocation before taking the refusal oracle.
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel(MODEL), ifcDataStore: data }),
    editEnabled: true, canCollabEdit: () => true, collabRoomId: null, collabSession: null,
    mutationViews: new Map([[MODEL, view]]), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(),
    mutationBatchTags: new Map(), removedNewEntities: new Map(), dirtyModels: new Set(), mutationVersion: 0,
  });
  return { data, view, adapter: createStoreAdapter(useViewerStore) };
}

for (const failure of ['shell', 'create-throw', 'attribute']) it(`failed ${failure} room publication restores local graph/history/allocator and leaves no partial peer graph (#6760)`, async () => {
  const { data, view, adapter } = await seed();
  const session = await createCollabSession({ roomId: 'publication-test', user: { id: 'test', name: 'Test' }, provider: 'memory' });
  const slot = { slotId: 'm0', pathPrefix: '/m0' };
  registerStoreSlot(data, slot);
  let shells = 0, attributes = 0;
  const observations: unknown[] = [];
  session.doc.on('afterTransaction', () => observations.push(session.snapshot().data));
  useViewerStore.setState({ collabRoomId: session.roomId, collabSession: session, collabRoomModels: new Map([[MODEL, slot]]),
    mirrorEntityCreate: (_model, id, type, guid) => {
      if (++shells === 3 && failure === 'shell') return; // Genuine absent registration after two real Yjs shell writes.
      assert.ok(guid);
      const path = pathForGuid(data, guid);
      session.transact(() => createEntity(session.doc, path, { ifcClass: type }));
      registerEntityPath(data, id, path);
      if (shells === 3 && failure === 'create-throw') throw new Error('Injected failure after registered shell');
    },
    mirrorAttributeEdit: (_model, id, name, value) => {
      if (++attributes === 3 && failure === 'attribute') throw new Error('Injected room attribute publication failure');
      const path = pathForEntity(data, id);
      assert.ok(path);
      session.transact(() => setAttribute(session.doc, path, name, value));
    },
    mirrorEntityRemove: (_model, id) => {
      const path = pathForEntity(data, id);
      if (path) session.transact(() => deleteEntity(session.doc, path));
      unregisterEntityPath(data, id);
    },
  });
  const snapshot = () => {
    const state = useViewerStore.getState();
    return structuredClone({ records: view.getNewEntities(), journal: view.getMutations(), changes: view.getEffectiveChanges(),
      next: view.peekNextExpressId(), undo: state.undoStacks, redo: state.redoStacks, tags: state.mutationBatchTags,
      stash: state.removedNewEntities, dirty: state.dirtyModels, version: state.mutationVersion });
  };
  const before = snapshot(), peerBefore = session.snapshot().data;
  observations.length = 0;
  try {
    assert.throws(() => adapter.addWall(MODEL, 42, { Start: [20,20,0], End: [24,20,0], Thickness: .2, Height: 3 }), /could not be published/);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(session.snapshot().data, peerBefore);
    assert.ok(observations.length > 0, 'real Yjs publication was attempted');
    assert.ok(observations.every(graph => JSON.stringify(graph) === JSON.stringify(peerBefore)), 'no observer saw a partial authored graph');
  } finally { session.dispose(); }
});

it('ordinary creation records only its appended journal rows as existing authoring grows (#6760)', async t => {
  const { view, adapter } = await seed();
  const original = view.getMutations.bind(view), entities = view.getNewEntities.bind(view);
  const reads: { since: number; rows: number }[] = [];
  let fullEntityReads = 0;
  view.getMutations = (since = 0) => { const rows = original(since); reads.push({ since, rows: rows.length }); return rows; };
  view.getNewEntities = () => { fullEntityReads++; return entities(); };
  const measured: { existing: number; read: number }[] = [];
  for (let index = 0; index < 12; index++) {
    const before = view.getMutationCount();
    reads.length = 0; fullEntityReads = 0;
    adapter.addWall(MODEL, 42, { Start: [20,index * 5,0], End: [24,index * 5,0], Thickness: .2, Height: 3 });
    assert.deepEqual(reads, [{ since: before, rows: view.getMutationCount() - before }]);
    assert.equal(fullEntityReads, 0, 'recording does not enumerate preexisting overlay entities');
    measured.push({ existing: before, read: reads[0].rows });
  }
  t.diagnostic(`Actual ordinary journal recording: ${JSON.stringify(measured)}`);
});
