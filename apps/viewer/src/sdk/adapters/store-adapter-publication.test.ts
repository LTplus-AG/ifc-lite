/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { createCollabSession, createEntity, deleteEntity, setAttribute, setPropertyValue, getPropertyValue, deletePropertyValue } from '@ifc-lite/collab';
import { useViewerStore } from '@/store';
import { bindRoomPropertyApi } from '@/lib/collab/room-property-api';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { registerStoreSlot, registerEntityPath, unregisterEntityPath, pathForGuid, pathForEntity } from '@/lib/collab/entity-paths';
import { parseIfcxViewerModel } from '@/hooks/ingest/viewerModelIngest';
import { beginCollabAttempt, collabAttemptApis } from '@/lib/collab/session-attempt';
import { createStoreAdapter } from './store-adapter.js';

// The slice's own mirror, captured before any test swaps in a stub.
const sliceMirrorEntityCreate = useViewerStore.getState().mirrorEntityCreate;

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
      registerEntityPath(data, id, path);
      session.transact(() => createEntity(session.doc, path, { ifcClass: type }));
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

it('the real create mirror resolves a new entity path when its creation publishes, and rolls it back on failure (#9453)', async () => {
  const { data } = await seed();
  const collab = await import('@ifc-lite/collab');
  const session = await createCollabSession({ roomId: 'mirror-path-publication', user: { id: 'test', name: 'Test' }, provider: 'memory' });
  const slot = { slotId: 'm0', pathPrefix: '/m0' };
  registerStoreSlot(data, slot);
  const attempt = beginCollabAttempt(session.roomId);
  attempt.adopt(session);
  const apis = collabAttemptApis(collab);
  attempt.apis = apis;
  useViewerStore.setState({ collabRoomId: session.roomId, collabSession: session, collabRoomModels: new Map([[MODEL, slot]]),
    mirrorEntityCreate: sliceMirrorEntityCreate });
  const id = 900_001, guid = '0Roof9453PublishPath01';
  const expected = pathForGuid(data, guid);
  const published: (string | null)[] = [];
  session.doc.on('afterTransaction', () => published.push(pathForEntity(data, id) ?? null));
  try {
    useViewerStore.getState().mirrorEntityCreate(MODEL, id, 'IfcRoof', guid, null);
    assert.ok(published.length > 0, 'the creation published a real Yjs transaction');
    assert.equal(published[0], expected, 'observers of the creating transaction resolve the new entity path');
    assert.equal(pathForEntity(data, id), expected);

    const failedId = 900_002, failedGuid = '0Roof9453PublishFail01';
    attempt.apis = { ...apis, doc: { ...apis.doc, createEntity: () => { throw new Error('Injected room create failure'); } } };
    assert.throws(() => useViewerStore.getState().mirrorEntityCreate(MODEL, failedId, 'IfcRoof', failedGuid, null), /Injected room create failure/);
    assert.equal(pathForEntity(data, failedId) ?? null, null, 'a failed creation leaves no registered path behind');
  } finally {
    attempt.retire();
    useViewerStore.setState({ collabRoomId: null, collabSession: null, collabRoomModels: new Map() });
  }
});

async function roofRoom() {
  bindRoomPropertyApi({ getPropertyValue, setPropertyValue, deletePropertyValue });
  const { data, view, adapter } = await seed();
  const session = await createCollabSession({ roomId: 'roof-publication', user: { id: 'test', name: 'Test' }, provider: 'memory' });
  const slot = { slotId: 'm0', pathPrefix: '/m0' };
  registerStoreSlot(data, slot);
  useViewerStore.setState({ collabRoomId: session.roomId, collabSession: session, collabRoomModels: new Map([[MODEL, slot]]),
    mirrorEntityCreate: (_model, id, type, guid) => {
      // Undo restores geometry records without IFC GlobalIds through their
      // existing room paths, just as the production mirror does.
      const path = pathForEntity(data, id) ?? (guid ? pathForGuid(data, guid) : null);
      assert.ok(path, 'a restored geometry record retains its room identity');
      registerEntityPath(data, id, path);
      session.transact(() => createEntity(session.doc, path, { ifcClass: type }));
    },
    mirrorAttributeEdit: (_model, id, name, value) => {
      const path = pathForEntity(data, id); assert.ok(path);
      session.transact(() => setAttribute(session.doc, path, name, value));
    },
    mirrorEntityRemove: (_model, id) => {
      const path = pathForEntity(data, id);
      if (path) session.transact(() => deleteEntity(session.doc, path));
      // The production mirror retains the identity so undo can restore it.
    },
    mirrorPropertyEdit: (_model, id, pset, prop, value) => {
      const path = pathForEntity(data, id); assert.ok(path);
      assert.ok(typeof value === 'string' || typeof value === 'number');
      session.transact(() => setPropertyValue(session.doc, path, pset, prop, { type: typeof value === 'number' ? 'IfcReal' : 'IfcText', value }));
    },
  });
  return { data, view, adapter, session };
}

it('a peer receives a new SDK roof footprint definition with its body (#9356 review)', async () => {
  const { data, adapter, session } = await roofRoom();
  try {
    const slopes = [Math.PI / 6, 0, Math.PI / 6, 0];
    const roof = adapter.addRoof(MODEL, 42, { Position: [0,0,4], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: slopes, Overhang: .5 });
    const path = pathForEntity(data, roof.expressId); assert.ok(path);
    const bytes = new TextEncoder().encode(JSON.stringify(session.snapshot()));
    const peer = await parseIfcxViewerModel(bytes.buffer, undefined, { allowEmptyGeometry: true });
    const id = peer.pathToId?.get(path); assert.ok(id);
    const view = new MutablePropertyView(peer.dataStore.properties, 'peer');
    assert.ok(view.getPropertyValue(id, 'IfcLite_RoofFootprint', 'Footprint'), 'a peer must retain the footprint so its next edit can rebuild the planes');
    assert.deepEqual(JSON.parse(String(view.getPropertyValue(id, 'IfcLite_RoofFootprint', 'EdgeSlopes'))), slopes);
    assert.equal(view.getPropertyValue(id, 'IfcLite_RoofFootprint', 'Overhang'), .5);
  } finally { session.dispose(); }
});

for (const surface of ['SDK', 'UI'] as const) for (const failAt of [1, 3]) {
  it(`${surface} roof create refuses atomically after ${failAt} real property writes (#9356 review r4509522892)`, async t => {
    const { data, view, adapter, session } = await roofRoom();
    t.after(() => session.dispose());
    const params = { Position: [0, 0, 4] as [number, number, number], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: Array(4).fill(Math.PI / 6) };
    const snapshot = () => {
      const state = useViewerStore.getState();
      return structuredClone({ records: view.getNewEntities(), journal: view.getMutations(), changes: view.getEffectiveChanges(),
        next: view.peekNextExpressId(), undo: state.undoStacks, redo: state.redoStacks, tags: state.mutationBatchTags,
        stash: state.removedNewEntities, dirty: state.dirtyModels, version: state.mutationVersion,
        tree: data.spatialHierarchy?.project, storeys: data.spatialHierarchy?.byStorey,
        containment: data.spatialHierarchy?.elementToStorey });
    };
    const before = snapshot(), peerBefore = session.snapshot().data;
    const observations: unknown[] = [], committedDuringPublication: boolean[] = [];
    session.doc.on('afterTransaction', () => observations.push(session.snapshot().data));
    const original = useViewerStore.getState().mirrorPropertyEdit;
    const record = useViewerStore.getState().recordAuthoredElement;
    let writes = 0, completions = 0, attemptedId = 0;
    useViewerStore.setState({
      mirrorPropertyEdit: (...args) => {
        attemptedId = args[1];
        committedDuringPublication.push(Boolean(view.getNewEntity(attemptedId)));
        original(...args);
        if (++writes === failAt) throw new Error('Injected roof property publication failure');
      },
      recordAuthoredElement: (...args) => { completions++; record(...args); },
    });
    const create = () => surface === 'SDK' ? adapter.addRoof(MODEL, 42, params) : useViewerStore.getState().addRoof(MODEL, 42, params);
    try {
      if (surface === 'SDK') assert.throws(create, /could not be published|Injected roof property publication failure/);
      else {
        const result = create();
        assert.ok('error' in result, 'UI reports a refused creation');
        assert.match(result.error, /could not be published/);
      }
      assert.equal(writes, failAt, 'the injected failure follows real Yjs property writes');
      assert.deepEqual(snapshot(), before, 'refusal preserves the complete local graph, allocator, history and spatial tree');
      assert.deepEqual(session.snapshot().data, peerBefore, 'the peer retains no new roof or partial footprint properties');
      assert.ok(observations.length > 0, 'real room publication was attempted');
      assert.ok(observations.every(graph => JSON.stringify(graph) === JSON.stringify(peerBefore)), 'no observer sees a partially published roof');
      assert.ok(committedDuringPublication.every(value => !value), 'publication runs while the roof is still a draft');
      assert.equal(pathForEntity(data, attemptedId), null, 'the refused roof releases its room identity');
      assert.equal(completions, 0, 'refused creation never starts tree/mesh completion');
      useViewerStore.setState({ mirrorPropertyEdit: original });
      const retry = create();
      assert.ok('expressId' in retry, 'the same creation can be retried');
      assert.equal(retry.expressId, attemptedId, 'refusal did not consume express IDs');
      assert.equal(completions, 1, 'successful retry reaches normal mesh/tree completion');
      const path = pathForEntity(data, retry.expressId); assert.ok(path);
      assert.deepEqual(getPropertyValue(session.doc, path, 'IfcLite_RoofFootprint', 'EdgeSlopes')?.value, JSON.stringify(params.EdgeSlopes));
    } finally {
      useViewerStore.setState({ mirrorPropertyEdit: original, recordAuthoredElement: record });
    }
  });
}

for (const failAt of [1, 3]) it(`roof edit property publication failure after ${failAt} real writes preserves local and peer state (#9356 review)`, async () => {
  const { view, adapter, session } = await roofRoom();
  const roof = adapter.addRoof(MODEL, 42, { Position: [0,0,4], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: Array(4).fill(Math.PI / 6) });
  const snapshot = () => {
    const state = useViewerStore.getState();
    return structuredClone({ records: view.getNewEntities(), journal: view.getMutations(), changes: view.getEffectiveChanges(),
      next: view.peekNextExpressId(), undo: state.undoStacks, redo: state.redoStacks, tags: state.mutationBatchTags,
      stash: state.removedNewEntities, dirty: state.dirtyModels, version: state.mutationVersion });
  };
  const before = snapshot(), peerBefore = session.snapshot().data;
  const editRoof = adapter.editRoof;
  assert.ok(editRoof, 'the viewer implements roof edits');
  const observations: unknown[] = [];
  session.doc.on('afterTransaction', () => observations.push(session.snapshot().data));
  const original = useViewerStore.getState().mirrorPropertyEdit;
  let writes = 0;
  useViewerStore.setState({ mirrorPropertyEdit: (...args) => {
    original(...args);
    if (++writes === failAt) throw new Error('Injected roof property publication failure');
  } });
  try {
    assert.throws(() => editRoof(roof, { Edge: { Index: 1, Slope: 0 }, Overhang: .5 }), /Injected roof property publication failure/);
    assert.deepEqual(snapshot(), before, 'a refused edit leaves graph, allocator and history untouched');
    assert.deepEqual(session.snapshot().data, peerBefore);
    assert.ok(observations.length > 0, 'real publication was attempted');
    assert.ok(observations.every(graph => JSON.stringify(graph) === JSON.stringify(peerBefore)), 'no peer observer sees partial roof metadata');
  } finally { useViewerStore.setState({ mirrorPropertyEdit: original }); session.dispose(); }
});
