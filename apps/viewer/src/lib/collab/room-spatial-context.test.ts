/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as collab from '@ifc-lite/collab';
import { IfcParser, extractGeoreferencingOnDemand } from '@ifc-lite/parser';
import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import { getEffectiveGeoreference } from '@/lib/geo/effective-georef.js';
import { totalYupOffset } from '@/lib/geo/coordinate-frame.js';
import { hasUsableMapGeoref, viewerPointToProjected } from '@/lib/geo/pick-to-geo.js';
import { buildShareSeed } from './share-scope.js';
import { buildGeometryResultFromMeshes } from './geometry-sync.js';
import { roomSlotRef } from './model-slot-ref.js';
import { createRoomSpatialContext, decodeRoomSpatialContext } from './room-spatial-context.js';
import { ownerShare, joiner } from '@/test/collab-room-harness.js';
import type { FederatedModel } from '@/store/types.js';
import { useViewerStore, type ViewerState } from '@/store/index.js';
import { createStore } from 'zustand/vanilla';
import { createDataSlice } from '@/store/slices/dataSlice.js';
import { createModelSlice } from '@/store/slices/modelSlice.js';
import { createMutationSlice } from '@/store/slices/mutationSlice.js';
import { createCollabSlice } from '@/store/slices/collabSlice.js';
import { StepExporter } from '@ifc-lite/export';
import type { Mutation } from '@ifc-lite/mutations';
import { attachRoomSpatialContextMirror } from './room-spatial-context-mirror.js';

// Use collab's exact ESM Yjs runtime, as the existing room peer tests do.
const collabResolve = createRequire(import.meta.resolve('@ifc-lite/collab'));
const runtimePath = collabResolve.resolve('yjs').replace(/dist[\\/]yjs\.cjs$/, 'dist/yjs.mjs');
const Y: {
  applyUpdate(doc: ReturnType<typeof collab.createCollabDoc>, update: Uint8Array): void;
  encodeStateAsUpdate(doc: ReturnType<typeof collab.createCollabDoc>): Uint8Array;
} = await import(pathToFileURL(runtimePath).href);

const sample = new URL('../../../public/samples/building-architecture.ifc', import.meta.url);
const frame: CoordinateInfo = {
  originShift: { x: 7, y: 11, z: -13 },
  wasmRtcOffset: { x: 4000, y: 5000, z: 6000 },
  wasmRtcFrame: { x: 4000, y: 5000, z: 6000, needsShift: true },
  originalBounds: { min: { x: 7, y: 11, z: -13 }, max: { x: 8, y: 12, z: -13 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
  hasLargeCoordinates: true,
  buildingRotation: Math.PI / 3,
  lengthUnitScale: 0.001,
};

async function model(id: string, offset = 0): Promise<FederatedModel> {
  // A real SketchUp export supplies CRS, project mm units and a rotated map conversion.
  const bytes = readFileSync(sample);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const wall = dataStore.getEntitiesByType('IfcWall')[0] ?? dataStore.getEntitiesByType('IfcBuilding')[0];
  assert.ok(wall);
  // Stated invariant: room mesh coordinates are already shifted. Distinct IFC
  // and viewer offsets must be retained, irrespective of the triangle's shape.
  const mesh: MeshData = { expressId: wall.expressId + offset, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), color: [1, 1, 1, 1] };
  return { id, name: 'georeferenced.ifc', ifcDataStore: dataStore,
    geometryResult: buildGeometryResultFromMeshes([mesh], structuredClone(frame)), schemaVersion: 'IFC4',
    visible: true, collapsed: false, loadedAt: 0, fileSize: dataStore.fileSize, idOffset: offset, maxExpressId: 100000, loadState: 'complete' };
}

function projectedPoint(model: FederatedModel) {
  const eff = getEffectiveGeoreference(model.ifcDataStore, model.geometryResult?.coordinateInfo);
  assert.ok(hasUsableMapGeoref(eff), 'World/coordinate consumers see the same usable CRS');
  const offset = totalYupOffset(model.geometryResult?.coordinateInfo);
  return viewerPointToProjected({ x: 0.25, y: 0.5, z: -0.75 }, eff,
    { x: -offset.x, y: -offset.y, z: -offset.z });
}

describe('room spatial context (#6499)', () => {
  for (const count of [1, 2]) it(`${count} shared model(s) preserve CRS, units and projected points through Yjs transport and rejoin`, async () => {
    const a = await model('A');
    const models = new Map([[a.id, a]]);
    if (count === 2) {
      const b = await model('B', 1000000);
      b.geometryResult!.coordinateInfo.originShift.x = 29;
      models.set(b.id, b);
    }
    const seed = buildShareSeed(models, 'A', 'all');
    const ownerDoc = collab.createCollabDoc();
    const blobs = new collab.MemoryBlobStore();
    const slots = new Map(seed.models.map((m, i) => [m.modelId, roomSlotRef(i)]));
    assert.equal((await ownerShare(ownerDoc, blobs, seed.models, slots)).outcome?.phase, 'ready');
    const doc = collab.createCollabDoc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(ownerDoc));
    const guest = joiner(doc, blobs, 'geo-test');
    try {
      await guest.reconstructor.reconstruct();
      assert.equal(guest.store.state().models.size, count);
      const received = [...guest.store.state().models.values()];
      for (let i = 0; i < count; i++) {
        const original = [...models.values()][i], shared = received[i];
        assert.deepEqual(projectedPoint(shared), projectedPoint(original));
        const georef = extractGeoreferencingOnDemand(shared.ifcDataStore!);
        assert.equal(georef?.projectedCRS?.name, 'EPSG:32760');
        assert.equal(georef?.projectedCRS?.mapUnitScale, 0.001);
        assert.equal(shared.ifcDataStore?.lengthUnitScale, 0.001);
        assert.equal(georef?.mapConversion?.id, 0, 'source STEP resource ids are not recipient entity refs');
        assert.deepEqual(shared.geometryResult?.coordinateInfo, original.geometryResult?.coordinateInfo);
        assert.equal(shared.geometryResult?.meshes.length, 1);
      }
      // A renderer may change its local frame; it must not mutate persisted room facts.
      received[0].geometryResult!.coordinateInfo.originShift.x = -999;
      assert.equal(decodeRoomSpatialContext(collab.getModelSlot(doc, 'm0')!.spatialContext)!.coordinateInfo?.originShift.x, frame.originShift.x);
      received[0].geometryResult!.coordinateInfo.originShift.x = frame.originShift.x;
      // A real peer edit triggers a fresh snapshot store, with cached mesh blobs.
      collab.setAttribute(doc, [...collab.iterEntities(doc)][0][0], 'bsi::ifc::prop::Name', 'Edited name');
      await guest.reconstructor.reconstruct();
      assert.deepEqual(projectedPoint([...guest.store.state().models.values()][0]), projectedPoint(a));
      assert.deepEqual(guest.notices, []);
    } finally { guest.reconstructor.teardown(); doc.destroy(); ownerDoc.destroy(); }
  });

  it('captures georeference edits and copies the live coordinate frame before seeding', async () => {
    const a = await model('A');
    const seed = buildShareSeed(new Map([[a.id, a]]), a.id, 'active', new Map([[a.id, { mapConversion: { eastings: 12345 } }]]));
    const context = decodeRoomSpatialContext(seed.models[0].spatialContext)!;
    assert.equal(context.georeferencing?.mapConversion?.eastings, 12345);
    a.geometryResult!.coordinateInfo.originShift.x = 999;
    assert.equal(context.coordinateInfo?.originShift.x, 7);
  });

  it('live owner edit and undo reach a connected peer without changing dense IFCX entities', async () => {
    const a = await model('A'), privateModel = await model('private');
    const doc = collab.createCollabDoc(), blobs = new collab.MemoryBlobStore();
    const seed = buildShareSeed(new Map([[a.id, a]]), a.id, 'all');
    await ownerShare(doc, blobs, seed.models, new Map([[a.id, roomSlotRef(0)]]));
    const session = await collab.createCollabSession({ roomId: 'spatial-edit', provider: 'memory', doc,
      user: { id: 'owner', name: 'Owner', color: '#123456' } });
    const peerDoc = collab.createCollabDoc();
    Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(doc));
    const send = (update: Uint8Array) => Y.applyUpdate(peerDoc, update);
    doc.on('update', send);
    const peer = joiner(peerDoc, blobs, 'spatial-edit-peer');
    const previous = useViewerStore.getState();
    useViewerStore.setState({ models: new Map([[a.id, a], [privateModel.id, privateModel]]), activeModelId: a.id,
      ifcDataStore: a.ifcDataStore, editEnabled: true, collabRoomId: 'spatial-edit', collabRole: 'admin',
      collabSession: session, collabRoomModels: new Map([[a.id, roomSlotRef(0)]]), georefMutations: new Map(),
      undoStacks: new Map(), redoStacks: new Map() });
    const detach = attachRoomSpatialContextMirror(useViewerStore, session);
    try {
      await peer.reconstructor.reconstruct();
      const entities = JSON.stringify(peerDoc.getMap('entities').toJSON());
      const original = extractGeoreferencingOnDemand(a.ifcDataStore!)!.mapConversion!.eastings;
      useViewerStore.getState().setGeorefField(a.id, 'mapConversion', 'eastings', original + 2500, original);
      await peer.reconstructor.reconstruct();
      const received = [...peer.store.state().models.values()][0];
      const geo = extractGeoreferencingOnDemand(received.ifcDataStore!)!;
      assert.equal(geo.mapConversion?.eastings, original + 2500);
      assert.equal(geo.transformMatrix?.[12], original + 2500, 'derived matrix matches the edited conversion');
      assert.equal(JSON.stringify(peerDoc.getMap('entities').toJSON()), entities, 'STEP ids never mutate dense IFCX entity rows');
      useViewerStore.getState().undo(a.id);
      await peer.reconstructor.reconstruct();
      assert.equal(extractGeoreferencingOnDemand([...peer.store.state().models.values()][0].ifcDataStore!)?.mapConversion?.eastings, original);
      const slot = JSON.stringify(doc.getMap('models').toJSON());
      useViewerStore.getState().setGeorefField(privateModel.id, 'mapConversion', 'eastings', 0, original);
      assert.equal(JSON.stringify(doc.getMap('models').toJSON()), slot, 'private model edits never reach shared metadata');
      useViewerStore.setState({ collabRole: 'viewer' });
      useViewerStore.getState().setGeorefField(a.id, 'mapConversion', 'eastings', 0, original);
      assert.equal(JSON.stringify(doc.getMap('models').toJSON()), slot, 'viewer role cannot edit shared georeferencing');
    } finally {
      detach(); doc.off('update', send); peer.reconstructor.teardown(); peerDoc.destroy(); session.dispose();
      useViewerStore.setState(previous, true);
    }
  });

  it('writer metadata reaches the native owner and later owner edits replace the writer overlay without echo', async () => {
    const a = await model('A');
    const sourceGeo = extractGeoreferencingOnDemand(a.ifcDataStore!)!;
    const doc = collab.createCollabDoc(), writerDoc = collab.createCollabDoc(), blobs = new collab.MemoryBlobStore();
    const seed = buildShareSeed(new Map([[a.id, a]]), a.id, 'all');
    await ownerShare(doc, blobs, seed.models, new Map([[a.id, roomSlotRef(0)]]));
    Y.applyUpdate(writerDoc, Y.encodeStateAsUpdate(doc));
    const reconstructed = joiner(writerDoc, blobs, 'writer');
    await reconstructed.reconstructor.reconstruct();
    const b = [...reconstructed.store.state().models.values()][0];
    const ownerSession = await collab.createCollabSession({ roomId: 'coherent', provider: 'memory', doc,
      user: { id: 'native-owner', name: 'Owner', color: '#123456' } });
    const writerSession = await collab.createCollabSession({ roomId: 'coherent', provider: 'memory', doc: writerDoc,
      user: { id: 'writer', name: 'Writer', color: '#654321' } });
    const makeStore = (m: FederatedModel, session: typeof ownerSession) => {
      const api = createStore<ViewerState>()((set, get, api) => ({ ...useViewerStore.getInitialState(),
        ...createModelSlice(set, get, api), ...createDataSlice(set, get, api),
        ...createMutationSlice(set, get, api), ...createCollabSlice(set, get, api) }));
      api.setState({ models: new Map([[m.id, m]]), activeModelId: m.id, ifcDataStore: m.ifcDataStore,
        editEnabled: true, collabRoomId: 'coherent', collabRole: 'admin', collabSession: session,
        collabRoomModels: new Map([[m.id, roomSlotRef(0)]]) });
      return api;
    };
    const owner = makeStore(a, ownerSession), writer = makeStore(b, writerSession);
    const stopOwner = attachRoomSpatialContextMirror(owner, ownerSession), stopWriter = attachRoomSpatialContextMirror(writer, writerSession);
    let ownerUpdates = 0, writerUpdates = 0;
    const sendOwner = (update: Uint8Array) => { ownerUpdates++; Y.applyUpdate(writerDoc, update); };
    const sendWriter = (update: Uint8Array) => { writerUpdates++; Y.applyUpdate(doc, update); };
    doc.on('update', sendOwner); writerDoc.on('update', sendWriter);
    try {
      const entities = JSON.stringify(doc.getMap('entities').toJSON());
      const original = sourceGeo.mapConversion!.eastings;
      writer.getState().setGeorefField(b.id, 'mapConversion', 'eastings', original + 2500, original);
      const received = extractGeoreferencingOnDemand(owner.getState().models.get(a.id)!.ifcDataStore!)!;
      assert.equal(received.mapConversion?.eastings, original + 2500);
      assert.equal(received.mapConversion?.id, sourceGeo.mapConversion?.id, 'native resource ids remain valid');
      assert.equal(received.projectedCRS?.id, sourceGeo.projectedCRS?.id);
      assert.equal(ownerUpdates, 1); assert.equal(writerUpdates, 1, 'incoming metadata produces no publication echo');
      const exported = new StepExporter(owner.getState().models.get(a.id)!.ifcDataStore!).export({
        schema: 'IFC4', includeGeometry: true, georefMutations: owner.getState().georefMutations.get(a.id) });
      const bytes = exported.content.slice();
      const reparsed = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
      assert.equal(extractGeoreferencingOnDemand(reparsed)?.mapConversion?.eastings, original + 2500);
      assert.equal(reparsed.entityIndex.byType.get('IFCMAPCONVERSION')?.length, 1, 'no duplicate conversion on native export');
      assert.equal(reparsed.entityIndex.byType.get('IFCPROJECTEDCRS')?.length, 1);
      // Dense IFCX id 0 is a real element, while geo history also uses 0.
      // An incoming metadata update may prune only the georef namespace.
      const unrelated: Mutation = { id: 'entity-zero-undo', type: 'UPDATE_ATTRIBUTE', timestamp: 0,
        modelId: b.id, entityId: 0, attributeName: 'Name', oldValue: 'original', newValue: 'local name' };
      const unrelatedRedo: Mutation = { ...unrelated, id: 'entity-zero-redo', attributeName: 'Description' };
      const geoUndo = writer.getState().undoStacks.get(b.id)![0];
      const geoRedo: Mutation = { ...geoUndo, id: 'geo-redo' };
      writer.setState({ undoStacks: new Map([[b.id, [unrelated, geoUndo]]]),
        redoStacks: new Map([[b.id, [unrelatedRedo, geoRedo]]]),
        mutationBatchTags: new Map([[unrelated.id, 'local'], [unrelatedRedo.id, 'local-redo'],
          [geoUndo.id, 'geo'], [geoRedo.id, 'geo-redo']]) });
      owner.getState().setGeorefField(a.id, 'mapConversion', 'eastings', original + 5000, original + 2500);
      const current = writer.getState().models.get(b.id)!;
      assert.equal(getEffectiveGeoreference(current.ifcDataStore, current.geometryResult?.coordinateInfo,
        writer.getState().georefMutations.get(b.id))?.mapConversion?.eastings, original + 5000, 'old writer overlay cannot mask the owner update');
      assert.equal(extractGeoreferencingOnDemand(current.ifcDataStore!)?.mapConversion?.id, 0, 'dense IFCX recipient has no source resource ids');
      assert.deepEqual(writer.getState().undoStacks.get(b.id), [unrelated]);
      assert.deepEqual(writer.getState().redoStacks.get(b.id), [unrelatedRedo]);
      assert.deepEqual([...writer.getState().mutationBatchTags], [[unrelated.id, 'local'], [unrelatedRedo.id, 'local-redo']]);
      assert.equal(ownerUpdates, 2); assert.equal(writerUpdates, 2);
      assert.equal(JSON.stringify(doc.getMap('entities').toJSON()), entities);
      assert.equal(JSON.stringify(writerDoc.getMap('entities').toJSON()), entities);
    } finally {
      stopOwner(); stopWriter(); doc.off('update', sendOwner); writerDoc.off('update', sendWriter);
      reconstructed.reconstructor.teardown(); ownerSession.dispose(); writerSession.dispose();
    }
  });

  it('old persisted slots retain zero coordinates and never invent a CRS', async () => {
    const a = await model('A');
    const seed = buildShareSeed(new Map([[a.id, a]]), a.id, 'all');
    const doc = collab.createCollabDoc(), blobs = new collab.MemoryBlobStore();
    await ownerShare(doc, blobs, seed.models, new Map([[a.id, roomSlotRef(0)]]));
    doc.getMap('models').set('m0', { name: 'old room', order: 0 });
    const guest = joiner(doc, blobs, 'old-room');
    try {
      await guest.reconstructor.reconstruct();
      const shared = [...guest.store.state().models.values()][0];
      assert.equal(shared.geometryResult?.meshes.length, 1);
      assert.equal(getEffectiveGeoreference(shared.ifcDataStore), null);
      assert.deepEqual(shared.geometryResult?.coordinateInfo.originShift, { x: 0, y: 0, z: 0 });
      assert.deepEqual(guest.notices, []);
    } finally { guest.reconstructor.teardown(); doc.destroy(); }
  });

  it('old source-backed rooms recover IFC facts without inventing an RTC frame', async () => {
    const a = await model('A');
    const seed = buildShareSeed(new Map([[a.id, a]]), a.id, 'all');
    seed.models[0].portableStepSource = a.ifcDataStore!.source.materialize();
    seed.models[0].portableStepSourceFormat = 'step';
    const doc = collab.createCollabDoc(), blobs = new collab.MemoryBlobStore();
    await ownerShare(doc, blobs, seed.models, new Map([[a.id, roomSlotRef(0)]]));
    const record = doc.getMap('models').get('m0') as Record<string, unknown>;
    const { spatialContext: _omitted, ...legacyRecord } = record;
    doc.getMap('models').set('m0', legacyRecord);
    const guest = joiner(doc, blobs, 'source-backed-old-room');
    try {
      await guest.reconstructor.reconstruct();
      const shared = [...guest.store.state().models.values()][0];
      assert.equal(extractGeoreferencingOnDemand(shared.ifcDataStore!)?.projectedCRS?.name, 'EPSG:32760');
      assert.equal(shared.ifcDataStore?.lengthUnitScale, 0.001);
      assert.deepEqual(shared.geometryResult?.coordinateInfo.originShift, { x: 0, y: 0, z: 0 });
      assert.equal(shared.geometryResult?.coordinateInfo.wasmRtcOffset, undefined);
      assert.deepEqual(guest.notices, []);
    } finally { guest.reconstructor.teardown(); doc.destroy(); }
  });

  it('rejects unsupported and non-finite remote metadata before it poisons coordinate arithmetic', async () => {
    const a = await model('A');
    const valid = createRoomSpatialContext(a.ifcDataStore!, frame);
    for (const bad of [null, [], { ...valid, version: 2 }, { ...valid, lengthUnitScale: -1 },
      { ...valid, coordinateInfo: { ...frame, originShift: { x: Infinity, y: 0, z: 0 } } },
      { ...valid, georeferencing: { hasGeoreference: true, projectedCRS: { id: 0, name: 'EPSG:32760', mapUnitScale: NaN } } }]) {
      assert.throws(() => decodeRoomSpatialContext(bad), /invalid or unsupported spatial metadata/);
    }
  });
});
