/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
