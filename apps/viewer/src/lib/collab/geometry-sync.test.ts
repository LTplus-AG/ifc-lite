/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createCollabDoc,
  createGeometry,
  hasEntity,
  addGeometryRef,
  setGeometryRef,
  getGeometryRef,
  getGeometry,
  iterEntities,
  seedFromStep,
  guidToPath,
  MemoryBlobStore,
} from '@ifc-lite/collab';
import type { MeshData } from '@ifc-lite/geometry';
import { encodeMesh, decodeMesh } from './mesh-codec.js';
import {
  seedGeometryToRoom,
  hydrateGeometryFromRoom,
  buildGeometryResultFromMeshes,
  type CollabGeomApi,
} from './geometry-sync.js';

function sampleMesh(expressId: number): MeshData {
  return {
    expressId,
    ifcType: 'IfcWallStandardCase',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    // f32-exact values so the round-trip compares cleanly.
    color: [0.5, 0.25, 0.75, 1],
  };
}

const api: CollabGeomApi = {
  createGeometry: (doc, geomId, opts) => createGeometry(doc, geomId, opts),
  hasEntity: (doc, path) => hasEntity(doc, path),
  addGeometryRef: (doc, path, geomId) => addGeometryRef(doc, path, geomId),
  setGeometryRef: (doc, path, ref) => setGeometryRef(doc, path, ref),
  getGeometryRef: (doc, path) => getGeometryRef(doc, path),
  getGeometry: (doc, geomId) => getGeometry(doc, geomId),
  iterEntities: (doc) => iterEntities(doc),
};

describe('mesh-codec', () => {
  it('round-trips a mesh exactly', () => {
    const mesh = sampleMesh(42);
    const decoded = decodeMesh(encodeMesh(mesh));
    assert.equal(decoded.expressId, 42);
    assert.equal(decoded.ifcType, 'IfcWallStandardCase');
    assert.deepEqual(Array.from(decoded.positions), Array.from(mesh.positions));
    assert.deepEqual(Array.from(decoded.normals), Array.from(mesh.normals));
    assert.deepEqual(Array.from(decoded.indices), Array.from(mesh.indices));
    assert.deepEqual(decoded.color, mesh.color);
  });

  it('rejects a buffer with a bad magic', () => {
    assert.throws(() => decodeMesh(new Uint8Array(32)));
  });
});

describe('geometry-sync seed → hydrate', () => {
  it('reconstructs meshes from the room blobs', async () => {
    const doc = createCollabDoc();
    const guidA = '0aBcDeFgHiJkLmNoPqRsT1';
    const guidB = '0aBcDeFgHiJkLmNoPqRsT2';
    seedFromStep(doc, {
      entities: [
        { guid: guidA, ifcClass: 'IfcWallStandardCase' },
        { guid: guidB, ifcClass: 'IfcSlab' },
      ],
    });

    const blobStore = new MemoryBlobStore();
    const session = { doc, transact: (fn: () => void) => doc.transact(fn) } as never;

    const expressToGuid = new Map<number, string>([
      [1, guidToPath(guidA)],
      [2, guidToPath(guidB)],
    ]);
    const meshes = [sampleMesh(1), sampleMesh(2)];

    const seeded = await seedGeometryToRoom(
      api,
      session,
      blobStore,
      meshes,
      (id) => expressToGuid.get(id) ?? null,
    );
    assert.equal(seeded, 2);

    const hydrated = await hydrateGeometryFromRoom(api, session, blobStore);
    assert.equal(hydrated.length, 2);
    const ids = hydrated.map((m) => m.expressId).sort();
    assert.deepEqual(ids, [1, 2]);
    for (const m of hydrated) {
      assert.deepEqual(Array.from(m.positions), Array.from(sampleMesh(m.expressId).positions));
    }
  });

  it('hydrates every mesh when one entity owns several (multi-material)', async () => {
    // A single element tessellated into 3 distinct meshes that all map to the
    // same GUID path. The per-entity GeometryRef can only hold one geomId, so
    // hydrating must read the geometry store, not the (last-wins) entity ref.
    const doc = createCollabDoc();
    const guid = '0aBcDeFgHiJkLmNoPqRsT9';
    seedFromStep(doc, { entities: [{ guid, ifcClass: 'IfcWallStandardCase' }] });

    const blobStore = new MemoryBlobStore();
    const session = { doc, transact: (fn: () => void) => doc.transact(fn) } as never;

    // Three meshes, same expressId → same path. Vary geometry so the blobs are
    // distinct (content-addressed dedupe would otherwise collapse them).
    const meshes: MeshData[] = [0, 1, 2].map((k) => ({
      ...sampleMesh(7),
      positions: new Float32Array([0, 0, k, 1, 0, k, 0, 1, k]),
    }));

    const seeded = await seedGeometryToRoom(api, session, blobStore, meshes, () => guidToPath(guid));
    assert.equal(seeded, 3);

    const hydrated = await hydrateGeometryFromRoom(api, session, blobStore);
    assert.equal(hydrated.length, 3, 'all 3 meshes recovered despite the shared entity path');
    const zs = hydrated.map((m) => m.positions[2]).sort();
    assert.deepEqual(zs, [0, 1, 2]);
  });

  it('re-keys mesh expressIds via pathToId (recipient id space)', async () => {
    const doc = createCollabDoc();
    const guidA = '0aBcDeFgHiJkLmNoPqRsT1';
    const guidB = '0aBcDeFgHiJkLmNoPqRsT2';
    seedFromStep(doc, {
      entities: [
        { guid: guidA, ifcClass: 'IfcWallStandardCase' },
        { guid: guidB, ifcClass: 'IfcSlab' },
      ],
    });
    const blobStore = new MemoryBlobStore();
    const session = { doc, transact: (fn: () => void) => doc.transact(fn) } as never;
    const expressToGuid = new Map<number, string>([
      [1, guidToPath(guidA)],
      [2, guidToPath(guidB)],
    ]);
    await seedGeometryToRoom(api, session, blobStore, [sampleMesh(1), sampleMesh(2)], (id) =>
      expressToGuid.get(id) ?? null,
    );

    // Recipient reconstructs ids by path: guidA→100, guidB→200.
    const pathToId = new Map<string, number>([
      [guidToPath(guidA), 100],
      [guidToPath(guidB), 200],
    ]);
    const hydrated = await hydrateGeometryFromRoom(api, session, blobStore, pathToId);
    assert.deepEqual(
      hydrated.map((m) => m.expressId).sort((a, b) => a - b),
      [100, 200],
      'expressIds are re-keyed into the recipient id space',
    );
  });
});

describe('buildGeometryResultFromMeshes', () => {
  it('computes totals + bounds for the renderer', () => {
    const result = buildGeometryResultFromMeshes([sampleMesh(1), sampleMesh(2)]);
    assert.equal(result.meshes.length, 2);
    assert.equal(result.totalTriangles, 2); // one triangle each
    assert.equal(result.totalVertices, 6); // three verts each
    assert.deepEqual(result.coordinateInfo.originShift, { x: 0, y: 0, z: 0 });
    assert.equal(result.coordinateInfo.shiftedBounds.max.x, 1);
    assert.equal(result.coordinateInfo.shiftedBounds.max.y, 1);
  });

  it('returns zero bounds for an empty mesh list', () => {
    const result = buildGeometryResultFromMeshes([]);
    assert.equal(result.totalVertices, 0);
    assert.deepEqual(result.coordinateInfo.shiftedBounds.min, { x: 0, y: 0, z: 0 });
  });
});
