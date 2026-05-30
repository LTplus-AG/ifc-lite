/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createCollabDoc,
  createGeometry,
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
});
