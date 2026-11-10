/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6232 — `bim.store.addOpening` / `addHostedDoor` / `addHostedWindow` through
 * the real `createStoreAdapter` over the real viewer store, on the committed
 * Bonsai hello-wall sample (host wall #1222). They write through the store's
 * `addHostedFill`, the action the Model workspace's placing commands commit
 * through (A1): so a script's door is ONE undo step, reaches a shared room,
 * and re-meshes its host with the void.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { pathForGuid, registerEntityPath, registerStoreSlot } from '@/lib/collab/entity-paths.js';
import { installScriptedMesher, settleRemesh } from '@/test/scripted-mesher';
import { createStoreAdapter } from './store-adapter.js';
import { readWallJoinRels, readWallJoinTarget } from '@ifc-lite/create';
import { toast } from '@/components/ui/toast';

const SAMPLE = new URL('../../../public/samples/hello-wall.ifc', import.meta.url);
const WALL = 1222;
const MODEL = 'm';

let mesher: ReturnType<typeof installScriptedMesher>;
let published: Array<{ entityId: number; ifcType: string }>;
let mirrored: number[];

async function seed({ canEdit = true, merged = false } = {}): Promise<IfcDataStore> {
  const bytes = readFileSync(SAMPLE);
  const dataStore = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  registerStoreSlot(dataStore, { slotId: 'm0', pathPrefix: '/m0' });
  // A colour-merged mesh (several entities in one) holding the wall: it cannot be swapped on its own.
  const mergedWall = { expressId: WALL, ifcType: 'IfcWall', positions: new Float32Array(9), normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1], entityIds: new Uint32Array([WALL, 7, 7]) } as unknown as MeshData;
  // Loaded through the wasm path, so a hosted filling re-meshes in this frame (#6232).
  const geometry = { meshes: merged ? [mergedWall] : [], totalTriangles: 0, totalVertices: 0,
    coordinateInfo: { wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false } } } as unknown as GeometryResult;
  published = [];
  mirrored = [];
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel(MODEL), ifcDataStore: dataStore, geometryResult: geometry } as unknown as FederatedModel),
    editEnabled: true,
    canCollabEdit: () => canEdit,
    collabRoomId: 'room',
    collabRoomModels: new Map([[MODEL, { slotId: 'm0', pathPrefix: '/m0' }]]),
    geometryResult: geometry,
    mutationViews: new Map([[MODEL, new MutablePropertyView(dataStore.properties || null, MODEL)]]),
    storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(),
    removedNewEntities: new Map(), removedMeshes: new Map(),
    pendingMeshRemovals: null, pendingMeshEdits: null, mutationVersion: 0,
    mirrorEntityCreate: (_modelId, entityId, ifcType, roomKey) => {
      published.push({ entityId, ifcType });
      if (roomKey) registerEntityPath(dataStore, entityId, pathForGuid(dataStore, roomKey));
    },
    mirrorAttributeEdit: () => {},
    mirrorEntityRemove: () => {},
    mirrorEntityGeometry: (_modelId, entityId) => { mirrored.push(entityId); },
  });
  return dataStore;
}

const meshedIds = () => (useViewerStore.getState().models.get(MODEL)?.geometryResult?.meshes ?? []).map((m) => m.expressId);
const live = (ifcClass: string) => {
  const view = useViewerStore.getState().mutationViews.get(MODEL)!;
  return view.getNewEntities().filter((e) => e.type.toUpperCase() === ifcClass && !view.isDeleted(e.expressId)).length;
};

describe('#6232 bim.store hosted openings, doors and windows', () => {
  beforeEach(() => { mesher = installScriptedMesher(); });
  afterEach(() => {
    mesher.restore();
    useViewerStore.setState({ collabRoomId: null, collabRoomModels: new Map() });
  });

  it('a script door is ONE undo step for the whole graph (no longer an undo fence)', async () => {
    await seed();
    const door = createStoreAdapter(useViewerStore).addHostedDoor(MODEL, WALL, { Offset: 8, Width: 0.9, Height: 2.1 });
    assert.equal(door.modelId, MODEL);
    const graph = ['IFCDOOR', 'IFCOPENINGELEMENT', 'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT'];
    for (const cls of graph) assert.equal(live(cls), 1, cls);
    assert.ok(useViewerStore.getState().canUndo(MODEL), 'history is kept, not cleared');
    useViewerStore.getState().undo(MODEL);
    for (const cls of graph) assert.equal(live(cls), 0, `${cls} undone by one Ctrl+Z`);
    assert.equal(useViewerStore.getState().canUndo(MODEL), false);
  });

  it('publishes the whole door graph to the room', async () => {
    await seed();
    createStoreAdapter(useViewerStore).addHostedDoor(MODEL, WALL, { Offset: 8, Width: 0.9, Height: 2.1 });
    const types = new Set(published.map((c) => c.ifcType.toUpperCase()));
    for (const type of ['IFCDOOR', 'IFCOPENINGELEMENT', 'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT', 'IFCRELCONTAINEDINSPATIALSTRUCTURE']) {
      assert.ok(types.has(type), `${type} was not published to the room`);
    }
  });

  it('re-meshes the host with a hosted window, so the wall comes back cut and both reach the room', async () => {
    await seed();
    // #6232: the source model already has a window at Offset 5; exercise remeshing on a clear span.
    const window = createStoreAdapter(useViewerStore).addHostedWindow(MODEL, WALL, { Offset: 8, Sill: 1, Width: 1.2, Height: 1.2 });
    await settleRemesh();
    assert.equal(mesher.requests.length, 1);
    const targets = [...mesher.requests[0].targets];
    for (const id of [window.expressId, WALL]) assert.ok(targets.includes(id), `#${id} is re-meshed`);
    assert.match(new TextDecoder().decode(mesher.requests[0].buffer), /IFCRELVOIDSELEMENT\(/, 'the host is meshed with the void that cuts it');
    for (const id of [window.expressId, WALL]) {
      assert.ok(meshedIds().includes(id), `#${id}'s mesh is swapped in`);
      assert.ok(mirrored.includes(id), `#${id}'s mesh is mirrored to the room`);
    }
    const before = mesher.requests.length;
    useViewerStore.getState().undo(MODEL);
    await settleRemesh();
    assert.ok(mesher.requests.slice(before).some((r) => [...r.targets].includes(WALL)), 'undo re-meshes the host without its void');
  });

  it('a colour-merged host keeps its mesh, and the new door still gets its own', async () => {
    await seed({ merged: true });
    const door = createStoreAdapter(useViewerStore).addHostedDoor(MODEL, WALL, { Offset: 8, Width: 0.9, Height: 2.1 });
    await settleRemesh();
    const targets = [...mesher.requests[0].targets];
    assert.ok(targets.includes(door.expressId), 'the door is re-meshed');
    assert.ok(!targets.includes(WALL), 'the merged host is left alone');
    assert.ok(mirrored.includes(door.expressId) && !mirrored.includes(WALL));
  });

  it('refuses every hosted call for a read-only participant, overlay untouched', async () => {
    await seed({ canEdit: false });
    const adapter = createStoreAdapter(useViewerStore);
    assert.throws(() => adapter.addOpening(MODEL, WALL, { Offset: 1, Width: 1, Height: 1 }), /Editing is disabled for your role/);
    assert.throws(() => adapter.addHostedDoor(MODEL, WALL, { Offset: 8, Width: 0.9, Height: 2.1 }), /Editing is disabled for your role/);
    assert.throws(() => adapter.addHostedWindow(MODEL, WALL, { Offset: 8, Sill: 1, Width: 1, Height: 1 }), /Editing is disabled for your role/);
    assert.equal(useViewerStore.getState().mutationViews.get(MODEL)!.getNewEntities().length, 0);
  });

  it('refuses a host that cannot take an opening, writing nothing', async () => {
    await seed();
    assert.throws(() => createStoreAdapter(useViewerStore).addHostedDoor(MODEL, 42, { Offset: 1, Width: 0.9, Height: 2.1 }),
      /bim\.store\.addHostedDoor: .*openings are supported in IfcWall and IfcSlab hosts/);
    assert.equal(useViewerStore.getState().mutationViews.get(MODEL)!.getNewEntities().length, 0);
    assert.equal(useViewerStore.getState().canUndo(MODEL), false);
  });

  it('#9409 viewer classifications use the slim factory and undo the whole association graph', async () => {
    await seed();
    const adapter = createStoreAdapter(useViewerStore);
    const wall = adapter.addWall(MODEL, 42, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 3 });
    assert.ok(adapter.addClassification, 'viewer exposes classification creation');
    assert.ok(adapter.assignClassification, 'viewer exposes classification assignment');
    adapter.addClassification(MODEL, { System: 'Example', Identification: 'Walls', objects: [wall.expressId] });
    const graph = ['IFCCLASSIFICATION', 'IFCCLASSIFICATIONREFERENCE', 'IFCRELASSOCIATESCLASSIFICATION'];
    for (const cls of graph) assert.equal(live(cls), 1, cls);
    for (const cls of graph) assert.ok(published.some(row => row.ifcType.toUpperCase() === cls), `${cls} reaches the room`);
    useViewerStore.getState().undo(MODEL);
    for (const cls of graph) assert.equal(live(cls), 0, `${cls} removed by one Undo`);
    assert.equal(live('IFCWALL'), 1, 'earlier wall creation is preserved');
    useViewerStore.getState().redo(MODEL);
    for (const cls of graph) assert.equal(live(cls), 1, `${cls} restored by Redo`);
    await settleRemesh();
  });

  for (const shared of [false, true]) it(`#9409 viewer mirror remeshes a hosted graph and supports Undo/Redo (shared=${shared})`, async () => {
    await seed();
    if (!shared) useViewerStore.setState({ collabRoomId: null, collabRoomModels: new Map() });
    const adapter = createStoreAdapter(useViewerStore);
    const wall = adapter.addWall(MODEL, 42, { Start: [2, 5, 0], End: [6, 5, 0], Thickness: .2, Height: 3 });
    const door = adapter.addHostedDoor(MODEL, wall.expressId, { Offset: 1, Width: .9, Height: 2.1, OperationType: 'SINGLE_SWING_LEFT' });
    await settleRemesh();
    assert.ok(adapter.mirrorElements, 'viewer exposes mirror through its history adapter');
    const from = mesher.requests.length;
    const result = adapter.mirrorElements(MODEL, [wall.expressId], { axis: [[0, 0], [0, 10]] });
    assert.deepEqual(result, [wall]);
    await settleRemesh();
    const targets = new Set(mesher.requests.slice(from).flatMap(request => [...request.targets]));
    for (const id of [wall.expressId, door.expressId]) assert.ok(targets.has(id), `mirrored #${id} is remeshed`);
    const view = useViewerStore.getState().mutationViews.get(MODEL)!;
    assert.equal(view.getNewEntity(door.expressId)?.attributes[11], '.SINGLE_SWING_RIGHT.');
    useViewerStore.getState().undo(MODEL);
    assert.equal(view.getNewEntity(door.expressId)?.attributes[11], '.SINGLE_SWING_LEFT.');
    assert.equal(live('IFCMAPPEDITEM'), 0, 'one Undo restores original geometry');
    useViewerStore.getState().redo(MODEL);
    assert.equal(view.getNewEntity(door.expressId)?.attributes[11], '.SINGLE_SWING_RIGHT.');
    assert.ok(live('IFCMAPPEDITEM') > 0);
    await settleRemesh();
  });

  it('#9406 returns and surfaces skipped implicit-join notices while preserving the added wall', async (t) => {
    // Observe the existing notice channel while still calling the real toast.
    const notices = t.mock.method(toast, 'info');
    const dataStore = await seed(), adapter = createStoreAdapter(useViewerStore);
    const host = adapter.addWall(MODEL, 42, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 3 });
    assert.equal(notices.mock.callCount(), 0, 'ordinary creation has no notice');
    adapter.addHostedDoor(MODEL, host.expressId, { Offset: 1, Width: .9, Height: 2.1 });
    const view = useViewerStore.getState().mutationViews.get(MODEL)!;
    const opening = view.getNewEntities().find(entity => entity.type.toUpperCase() === 'IFCOPENINGELEMENT');
    assert.ok(opening);
    new StoreEditor(dataStore, view).setPositionalAttribute(opening.expressId, 6, null);
    const beforeHost = readWallJoinTarget(dataStore, view, host.expressId, 1);
    const beforeJoins = readWallJoinRels(dataStore, view);
    const wall = adapter.addWall(MODEL, 42, { Start: [4, 5, 0], End: [4, 8, 0], Thickness: .2, Height: 3 });
    assert.match(wall.notices?.join('\n') ?? '', /skipped.*join.*unreadable opening geometry/i);
    assert.deepEqual(notices.mock.calls.map(call => call.arguments), [[wall.notices!.join('\n')]],
      'the viewer surfaces the returned notice through its real toast channel');
    assert.ok(view.getNewEntity(wall.expressId), 'the wall is added despite the refused implicit join');
    assert.deepEqual(readWallJoinRels(dataStore, view), beforeJoins);
    assert.deepEqual(readWallJoinTarget(dataStore, view, host.expressId, 1), beforeHost);
    const beforeExplicit = view.getMutations();
    assert.throws(() => adapter.joinWalls(MODEL, host.expressId, wall.expressId), /unreadable opening geometry/);
    assert.deepEqual(view.getMutations(), beforeExplicit, 'explicit joining still refuses atomically');
    await settleRemesh();
  });

  for (const shared of [false, true]) it(`#9406 implicit joins book and remesh both walls in one undo step (shared=${shared})`, async (t) => {
    const dataStore = await seed(), adapter = createStoreAdapter(useViewerStore);
    if (!shared) useViewerStore.setState({ collabRoomId: null, collabRoomModels: new Map() });
    const a = adapter.addWall(MODEL, 42, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 3 }).expressId;
    await settleRemesh();
    const view = useViewerStore.getState().mutationViews.get(MODEL)!;
    const before = readWallJoinTarget(dataStore, view, a, 1)!;
    const record = useViewerStore.getState().recordAuthoredElement;
    const booked = t.mock.fn(record);
    useViewerStore.setState({ recordAuthoredElement: booked });
    t.after(() => useViewerStore.setState({ recordAuthoredElement: record }));
    const from = mesher.requests.length;
    const b = adapter.addWall(MODEL, 42, { Start: [4, 5, 0], End: [4, 8, 0], Thickness: .2, Height: 3 }).expressId;
    await settleRemesh();
    assert.equal(readWallJoinRels(dataStore, view).length, 1);
    const targets = new Set(mesher.requests.slice(from).flatMap(r => [...r.targets]));
    for (const id of [a, b]) assert.ok(targets.has(id), `changed wall #${id} is re-meshed by the addWall commit`);
    assert.deepEqual(new Set(booked.mock.calls.map(c => c.arguments[2])), new Set([a, b]), 'both walls reach authored bookkeeping');
    const joinedProfile = readWallJoinTarget(dataStore, view, a, 1)!.profileId;
    assert.notEqual(joinedProfile, before.profileId);
    const undoFrom = mesher.requests.length;
    useViewerStore.getState().undo(MODEL);
    await settleRemesh();
    assert.equal(view.getNewEntity(b), null, 'one undo removes the new wall');
    assert.ok(view.getNewEntity(a), 'the earlier wall remains');
    assert.equal(readWallJoinTarget(dataStore, view, a, 1)?.profileId, before.profileId);
    assert.ok(view.getNewEntity(before.profileId), 'undo restores the neighbour profile forgotten by the join');
    assert.equal(readWallJoinRels(dataStore, view).length, 0);
    assert.ok(mesher.requests.slice(undoFrom).some(r => [...r.targets].includes(a)), 'undo re-meshes the restored neighbour');
    const redoFrom = mesher.requests.length;
    useViewerStore.getState().redo(MODEL);
    await settleRemesh();
    assert.equal(readWallJoinRels(dataStore, view).length, 1);
    assert.equal(readWallJoinTarget(dataStore, view, a, 1)?.profileId, joinedProfile);
    const redone = new Set(mesher.requests.slice(redoFrom).flatMap(r => [...r.targets]));
    for (const id of [a, b]) assert.ok(redone.has(id), `redo re-meshes changed wall #${id}`);
  });

  it('#9406 an implicit join at each end books and remeshes every changed neighbour', async (t) => {
    const dataStore = await seed(), adapter = createStoreAdapter(useViewerStore);
    const wall = (Start: [number, number, number], End: [number, number, number]) =>
      adapter.addWall(MODEL, 42, { Start, End, Thickness: .2, Height: 3 }).expressId;
    const a = wall([0, 5, 0], [4, 5, 0]), b = wall([4, 8, 0], [0, 8, 0]);
    await settleRemesh();
    const record = useViewerStore.getState().recordAuthoredElement, booked = t.mock.fn(record);
    useViewerStore.setState({ recordAuthoredElement: booked });
    t.after(() => useViewerStore.setState({ recordAuthoredElement: record }));
    const from = mesher.requests.length, c = wall([4, 5, 0], [4, 8, 0]);
    await settleRemesh();
    const view = useViewerStore.getState().mutationViews.get(MODEL)!;
    assert.equal(readWallJoinRels(dataStore, view).length, 2);
    const targets = new Set(mesher.requests.slice(from).flatMap(r => [...r.targets]));
    assert.deepEqual(targets, new Set([a, b, c]));
    assert.deepEqual(new Set(booked.mock.calls.map(call => call.arguments[2])), targets);
  });

  it('#6232 joins through the SDK core, re-meshes both walls and restores forgotten profiles in one undo', async () => {
    const dataStore = await seed();
    const adapter = createStoreAdapter(useViewerStore);
    const a = adapter.addWall(MODEL, 42, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: 0.2, Height: 3 }).expressId;
    // #9296: keep a small gap so creation does not auto-join. This test owns
    // the explicit join and must be able to undo it back to separate walls.
    const b = adapter.addWall(MODEL, 42, { Start: [4, 5.2, 0], End: [4, 8, 0], Thickness: 0.2, Height: 3 }).expressId;
    const view = useViewerStore.getState().mutationViews.get(MODEL)!;
    assert.equal(readWallJoinRels(dataStore, view).length, 0, 'the explicit join starts with separate walls');
    const before = readWallJoinTarget(dataStore, view, a, 1)!;
    adapter.joinWalls(MODEL, a, b, { Name: 'SDK corner' });
    assert.equal(readWallJoinRels(dataStore, view).length, 1);
    assert.equal(view.getNewEntity(before.profileId), null, 'the join forgot its earlier profile');
    await settleRemesh();
    assert.ok(mesher.requests.some(r => [...r.targets].includes(a) && [...r.targets].includes(b)), 'both walls are re-meshed');
    useViewerStore.getState().undo(MODEL);
    assert.equal(readWallJoinRels(dataStore, view).length, 0);
    assert.equal(readWallJoinTarget(dataStore, view, a, 1)?.profileId, before.profileId);
    assert.ok(view.getNewEntity(before.profileId), 'one undo restored the earlier profile');
    assert.ok(view.getNewEntity(a) && view.getNewEntity(b), 'earlier wall creation is preserved');
  });

  it('#6232 refuses near-face cuts and unknown opening references through the shared join guard', async () => {
    const dataStore = await seed(), adapter = createStoreAdapter(useViewerStore);
    const a = adapter.addWall(MODEL, 42, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: 0.2, Height: 3 }).expressId;
    // #9296: the explicit near-face refusal needs an opening in an unjoined
    // host. The axes still meet within join tolerance, but endpoints differ.
    const b = adapter.addWall(MODEL, 42, { Start: [4.05, 5.05, 0], End: [5, 6, 0], Thickness: 0.4, Height: 3 }).expressId;
    adapter.addHostedWindow(MODEL, a, { Offset: 3.9, Sill: 1, Width: 0.1, Height: 1 });
    const view = useViewerStore.getState().mutationViews.get(MODEL)!;
    assert.equal(readWallJoinRels(dataStore, view).length, 0, 'opening placement precedes the explicit join');
    const before = view.getMutations(), undo = useViewerStore.getState().undoStacks.get(MODEL);
    assert.throws(() => adapter.joinWalls(MODEL, a, b, { priority: 'b' }), /would not fit between the joined end faces/);
    assert.deepEqual(view.getMutations(), before);
    assert.deepEqual(useViewerStore.getState().undoStacks.get(MODEL), undo);
    new StoreEditor(dataStore, view).addEntity('IfcRelVoidsElement', ['broken', null, null, null, `#${a}`, '#999999']);
    const broken = view.getMutations();
    assert.throws(() => adapter.joinWalls(MODEL, a, b), /unreadable opening geometry/);
    assert.deepEqual(view.getMutations(), broken);
    assert.equal(readWallJoinRels(dataStore, view).length, 0);
  });
});
