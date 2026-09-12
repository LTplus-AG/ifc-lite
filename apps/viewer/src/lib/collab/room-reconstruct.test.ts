/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4444 — one room, two copies of one file, and a recipient who sees both.
 *
 * The owner side (`runOwnerSeed`) and the recipient side
 * (`createRoomReconstructor`) are driven for real through
 * `test/collab-room-harness.ts` — real collab document, real
 * `MemoryBlobStore`, the real IFCX importer and the real model/data slices —
 * so the assertions are about what a joiner's store ends up holding: two
 * federated models in disjoint global-id ranges, each with its own geometry
 * and its own texture. `room-two-copies.ac20.test.ts` runs the same sequence
 * over the real AC20-FZK-Haus.ifc fixture.
 *
 * The two "files" are byte-for-byte the same shape: same GlobalIds, same
 * local express ids, same containment. Only their meshes differ (position and
 * image pixels), which is exactly the workspace the issue reproduces: one
 * building loaded twice with a different appearance source applied to each.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as collab from '@ifc-lite/collab';
import type { ModelSlotRef } from '@ifc-lite/collab';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import { readGeometrySeedMarker } from './geometry-seed-signal.js';
import type { CollabSeedInput } from './owner-seed.js';
import { roomSlotRef } from './model-slot-ref.js';
import { joiner, localIdOf, ownerShare, texturePixel, type RoomDoc } from '../../test/collab-room-harness.js';

const WALL_GUID = '0aBcDeFgHiJkLmNoPqRsT1';
const STOREY_GUID = '0aBcDeFgHiJkLmNoPqRsT2';
const STOREY_ID = 1;
const WALL_ID = 2;

/** A STEP-shaped store: two IfcRoot entities, the same in every copy. */
function stepStore(): IfcDataStore {
  const rows = new Map<number, { guid: string; name: string; type: string; step: string }>([
    [STOREY_ID, { guid: STOREY_GUID, name: 'Level 1', type: 'IfcBuildingStorey', step: 'IFCBUILDINGSTOREY' }],
    [WALL_ID, { guid: WALL_GUID, name: 'Wall-A', type: 'IfcWallStandardCase', step: 'IFCWALLSTANDARDCASE' }],
  ]);
  return {
    source: new Uint8Array(0),
    entityIndex: {
      byId: new Map(Array.from(rows, ([id, r]) => [id, { type: r.step, byteOffset: 0, byteLength: 0 }])),
      byType: new Map(),
    },
    entities: {
      getGlobalId: (id: number) => rows.get(id)?.guid ?? '',
      getName: (id: number) => rows.get(id)?.name ?? '',
      getDescription: () => '',
      getObjectType: () => '',
      getTypeName: (id: number) => rows.get(id)?.type ?? 'Unknown',
    },
    properties: { getForEntity: () => [] },
    relationships: { getRelated: () => [] },
    spatialHierarchy: {
      project: { expressId: STOREY_ID, children: [], elements: [WALL_ID] },
      storeyElevations: new Map(),
    },
    schemaVersion: 'IFC4',
  } as unknown as IfcDataStore;
}

/** The wall's mesh in one copy: a triangle at `x`, textured with one flat colour. */
function wallMesh(x: number, rgb: [number, number, number], idOffset: number): MeshData {
  const rgba = new Uint8Array(4 * 4);
  for (let i = 0; i < 4; i++) rgba.set([...rgb, 255], i * 4);
  return {
    // Federated models hold GLOBAL ids on their meshes.
    expressId: WALL_ID + idOffset,
    ifcType: 'IfcWallStandardCase',
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    texture: { width: 2, height: 2, rgba, repeatS: false, repeatT: true },
  };
}

/** Owner: share both copies into `doc`, copy B offset like a federated file. */
async function shareTwoCopies(doc: RoomDoc, blobStore: collab.MemoryBlobStore) {
  const B_OFFSET = 1_000_000;
  const seed: CollabSeedInput = {
    models: [
      { modelId: 'A', name: 'AC20-FZK-Haus.ifc', store: stepStore(), isIfcx: false, meshes: [wallMesh(0, [255, 0, 0], 0)], idOffset: 0, schemaVersion: 'IFC4', fileName: 'AC20-FZK-Haus.ifc' },
      { modelId: 'B', name: 'AC20-FZK-Haus.ifc', store: stepStore(), isIfcx: false, meshes: [wallMesh(50, [0, 0, 255], B_OFFSET)], idOffset: B_OFFSET, schemaVersion: 'IFC4', fileName: 'AC20-FZK-Haus.ifc' },
    ],
  };
  const roomModels = new Map<string, ModelSlotRef>([
    ['A', roomSlotRef(0)],
    ['B', roomSlotRef(1)],
  ]);
  return ownerShare(doc, blobStore, seed.models, roomModels);
}

describe('room seed + reconstruct: two copies of one file (#4444)', () => {
  let doc: RoomDoc;
  let blobStore: collab.MemoryBlobStore;

  beforeEach(async () => {
    doc = collab.createCollabDoc();
    blobStore = new collab.MemoryBlobStore();
    const { outcome, phases } = await shareTwoCopies(doc, blobStore);
    assert.deepEqual(outcome, { phase: 'ready', failure: null });
    assert.deepEqual(phases, ['structure', 'geometry', 'structure', 'geometry'], 'one structure → geometry pass per slot');
    assert.equal(readGeometrySeedMarker(doc)?.seeded, 2, 'both walls landed, and the marker says so');
  });

  it('owner: the room holds two slots, twice the entities, and one geometry ref per copy', async () => {
    assert.deepEqual(
      collab.listModelSlots(doc).map((s) => [s.slotId, s.name, s.order]),
      [['m0', 'AC20-FZK-Haus.ifc', 0], ['m1', 'AC20-FZK-Haus.ifc', 1]],
    );
    assert.equal(doc.getMap('entities').size, 4);
    const refA = collab.getGeometryRef(doc, `/m0/${WALL_GUID}`);
    const refB = collab.getGeometryRef(doc, `/m1/${WALL_GUID}`);
    assert.equal(refA?.geomIds.length, 1);
    assert.equal(refB?.geomIds.length, 1);
    assert.notEqual(refA?.geomIds[0], refB?.geomIds[0], 'different meshes, different content hashes, not merged');
    // Re-running the share (a reconnect) neither duplicates structure nor re-uploads.
    const before = doc.getMap('geometry').size;
    const again = await shareTwoCopies(doc, blobStore);
    assert.deepEqual(again.phases, [], 'no slot is re-seeded');
    assert.equal(again.outcome?.phase, 'ready');
    assert.equal(doc.getMap('entities').size, 4);
    assert.equal(doc.getMap('geometry').size, before);
  });

  it('recipient: one federated model per slot, disjoint id ranges, each with its own geometry and texture', async () => {
    const { reconstructor, store } = joiner(doc, blobStore, 'r1');
    await reconstructor.reconstruct();
    const s = store.state();

    assert.deepEqual(Array.from(s.models.keys()).sort(), ['room:r1:m0', 'room:r1:m1']);
    assert.deepEqual(Array.from(s.collabRoomModels.keys()), ['room:r1:m0', 'room:r1:m1']);
    const a = s.models.get('room:r1:m0')!;
    const b = s.models.get('room:r1:m1')!;
    assert.equal(a.name, 'AC20-FZK-Haus.ifc');
    assert.equal(b.name, 'AC20-FZK-Haus.ifc');
    assert.ok(b.idOffset > a.idOffset + a.maxExpressId, 'copy B sits above copy A in the global id space');

    // Same GlobalId (bar the slot prefix) and the same local express id in
    // both stores — the two copies are indistinguishable by IFC identity,
    // which is the whole point; only the federation range tells them apart.
    const wallLocalA = localIdOf(a, `/m0/${WALL_GUID}`);
    const wallLocalB = localIdOf(b, `/m1/${WALL_GUID}`);
    assert.equal(wallLocalA, wallLocalB, 'two copies of one file allocate the same local ids');
    const wallA = s.resolveGlobalIdFromModels(a.idOffset + wallLocalA);
    const wallB = s.resolveGlobalIdFromModels(b.idOffset + wallLocalB);
    assert.deepEqual(wallA, { modelId: 'room:r1:m0', expressId: wallLocalA });
    assert.deepEqual(wallB, { modelId: 'room:r1:m1', expressId: wallLocalB });

    // Each model rendered exactly its own copy's mesh, re-homed into its range.
    const meshesA = a.geometryResult?.meshes ?? [];
    const meshesB = b.geometryResult?.meshes ?? [];
    assert.equal(meshesA.length, 1);
    assert.equal(meshesB.length, 1);
    assert.equal(meshesA[0].expressId, a.idOffset + wallLocalA);
    assert.equal(meshesB[0].expressId, b.idOffset + wallLocalB);
    assert.equal(meshesA[0].positions[0], 0);
    assert.equal(meshesB[0].positions[0], 50);
    assert.deepEqual(texturePixel(meshesA[0]), [255, 0, 0], 'copy A keeps its red image');
    assert.deepEqual(texturePixel(meshesB[0]), [0, 0, 255], 'copy B keeps its blue image');
  });

  it('rejoin: leaving drops both models, joining again rebuilds both', async () => {
    const first = joiner(doc, blobStore, 'r1');
    await first.reconstructor.reconstruct();
    assert.equal(first.store.state().models.size, 2);
    first.reconstructor.teardown();
    assert.equal(first.store.state().models.size, 0, 'teardown removes every room model');

    const again = joiner(doc, blobStore, 'r1');
    await again.reconstructor.reconstruct();
    const s = again.store.state();
    assert.deepEqual(Array.from(s.models.keys()).sort(), ['room:r1:m0', 'room:r1:m1']);
    const a = s.models.get('room:r1:m0')!;
    const b = s.models.get('room:r1:m1')!;
    assert.ok(b.idOffset > a.idOffset + a.maxExpressId);
    assert.deepEqual(texturePixel(b.geometryResult!.meshes[0]), [0, 0, 255]);
    again.reconstructor.teardown();
  });

  it('a second reconstruct (peer edit) refreshes both models in place without re-registering', async () => {
    const { reconstructor, store } = joiner(doc, blobStore, 'r1');
    await reconstructor.reconstruct();
    const before = new Map(Array.from(store.state().models, ([id, m]) => [id, m.idOffset]));
    collab.setAttribute(doc, `/m1/${WALL_GUID}`, 'bsi::ifc::prop::Name', 'Renamed in copy B');
    await reconstructor.reconstruct();
    const s = store.state();
    assert.equal(s.models.size, 2);
    for (const [id, offset] of before) assert.equal(s.models.get(id)?.idOffset, offset, `${id} keeps its range`);
    const b = s.models.get('room:r1:m1')!;
    assert.equal(b.ifcDataStore?.entities.getName(localIdOf(b, `/m1/${WALL_GUID}`)), 'Renamed in copy B');
    const a = s.models.get('room:r1:m0')!;
    assert.equal(a.ifcDataStore?.entities.getName(localIdOf(a, `/m0/${WALL_GUID}`)), 'Wall-A', 'copy A is untouched');
    reconstructor.teardown();
  });
});

describe('room reconstruct: a room shared before slots existed', () => {
  it('reconstructs as one legacy slot named after the shared file', async () => {
    const doc = collab.createCollabDoc();
    collab.seedFromStep(doc, {
      header: { schema: 'IFC4', fileName: 'old-room.ifc' },
      entities: [{ guid: WALL_GUID, ifcClass: 'IfcWall' }],
    });
    const blobStore = new collab.MemoryBlobStore();
    const { reconstructor, store } = joiner(doc, blobStore, 'r2');
    await reconstructor.reconstruct();
    const s = store.state();
    assert.deepEqual(Array.from(s.models.keys()), ['room:r2:m0']);
    assert.equal(s.models.get('room:r2:m0')?.name, 'old-room.ifc');
    assert.deepEqual(Array.from(s.collabRoomModels.values()), [
      { slotId: 'm0', pathPrefix: '', name: 'old-room.ifc', order: 0, legacy: true },
    ]);
    const model = s.models.get('room:r2:m0')!;
    const wallLocal = localIdOf(model, `/${WALL_GUID}`);
    assert.deepEqual(s.resolveGlobalIdFromModels(model.idOffset + wallLocal), { modelId: 'room:r2:m0', expressId: wallLocal });
    reconstructor.teardown();
  });
});

/**
 * #4444 — byte-identical copies. Geometry is content-addressed, so two copies
 * whose meshes hash the same share ONE geometry record; only the second
 * slot's refs differ. A recipient that keyed "did geometry change" on the
 * record count alone left the second model empty for good.
 */
describe('room reconstruct: two byte-identical copies share one geometry record', () => {
  type SeedModel = CollabSeedInput['models'][number];
  const copy = (modelId: string, idOffset: number, meshes: MeshData[] | null): SeedModel => ({
    modelId,
    name: 'AC20-FZK-Haus.ifc',
    store: stepStore(),
    isIfcx: false,
    meshes,
    idOffset,
    schemaVersion: 'IFC4',
    fileName: 'AC20-FZK-Haus.ifc',
  });
  const roomModels = new Map<string, ModelSlotRef>([
    ['A', roomSlotRef(0)],
    ['B', roomSlotRef(1)],
  ]);
  const share = (doc: RoomDoc, blobStore: collab.MemoryBlobStore, models: SeedModel[]) =>
    ownerShare(doc, blobStore, models, roomModels);

  /**
   * The room state an IFCX share of two identical copies produces: the seed
   * re-parses each copy's own bytes (local ids, identical encodings), so the
   * second copy's upload dedupes onto the first's record and only its refs
   * are new. (A STEP share encodes the mesh's federation-global expressId, so
   * two STEP copies never collide — see `mesh-codec.ts`; the doc shape is what
   * the reconstructor has to handle, so it is built directly here.)
   */
  function pointSecondCopyAtFirstRecord(doc: RoomDoc): void {
    const ref = collab.getGeometryRef(doc, `/m0/${WALL_GUID}`);
    assert.ok(ref && ref.geomIds.length === 1);
    doc.transact(() => collab.addGeometryRef(doc, `/m1/${WALL_GUID}`, ref.geomIds[0]));
  }

  it('both slots hydrate the shared mesh, each into its own id range', async () => {
    const doc = collab.createCollabDoc();
    const blobStore = new collab.MemoryBlobStore();
    await share(doc, blobStore, [copy('A', 0, [wallMesh(0, [0, 255, 0], 0)]), copy('B', 1_000_000, null)]);
    pointSecondCopyAtFirstRecord(doc);
    assert.equal(doc.getMap('geometry').size, 1, 'one record for two copies');
    assert.deepEqual(collab.getGeometryRef(doc, `/m0/${WALL_GUID}`), collab.getGeometryRef(doc, `/m1/${WALL_GUID}`));

    const { reconstructor, store } = joiner(doc, blobStore, 'r3');
    await reconstructor.reconstruct();
    const s = store.state();
    const a = s.models.get('room:r3:m0')!;
    const b = s.models.get('room:r3:m1')!;
    assert.equal(a.geometryResult?.meshes.length, 1);
    assert.equal(b.geometryResult?.meshes.length, 1);
    assert.equal(a.geometryResult!.meshes[0].expressId, a.idOffset + localIdOf(a, `/m0/${WALL_GUID}`));
    assert.equal(b.geometryResult!.meshes[0].expressId, b.idOffset + localIdOf(b, `/m1/${WALL_GUID}`));
    assert.notEqual(a.geometryResult!.meshes[0].positions, b.geometryResult!.meshes[0].positions, 'each model owns its vertex copy');
    reconstructor.teardown();
  });

  it('a second slot whose refs land after the first reconstruct, with no new record, still hydrates', async () => {
    const doc = collab.createCollabDoc();
    const blobStore = new collab.MemoryBlobStore();
    await share(doc, blobStore, [copy('A', 0, [wallMesh(0, [0, 255, 0], 0)])]);
    const { reconstructor, store } = joiner(doc, blobStore, 'r4');
    await reconstructor.reconstruct();
    assert.equal(store.state().models.size, 1);

    // Copy B's structure lands (a joiner mid-seed sees exactly this) …
    await share(doc, blobStore, [copy('B', 1_000_000, null)]);
    await reconstructor.reconstruct();
    const empty = store.state().models.get('room:r4:m1')!;
    assert.equal(empty.geometryResult?.meshes.length ?? 0, 0, 'no refs yet, nothing to hydrate');

    // … then its geometry: the same mesh as copy A's, so the geometry map does
    // not grow — only copy B's ref does.
    const before = doc.getMap('geometry').size;
    pointSecondCopyAtFirstRecord(doc);
    assert.equal(doc.getMap('geometry').size, before, 'content-addressed: no new record');
    await reconstructor.reconstruct();
    const b = store.state().models.get('room:r4:m1')!;
    assert.equal(b.geometryResult?.meshes.length, 1, 'the ref-only change re-hydrated copy B');
    assert.deepEqual(texturePixel(b.geometryResult!.meshes[0]), [0, 255, 0]);
    reconstructor.teardown();
  });
});
