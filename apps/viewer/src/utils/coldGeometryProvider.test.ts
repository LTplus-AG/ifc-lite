/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import { buildGeometrySectionV13, openGeometryChunksV13 } from '@ifc-lite/cache';
import { makeColdGeometryProvider } from './coldGeometryProvider.js';

const coordInfo: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  hasLargeCoordinates: false,
};

function mesh(expressId: number, at: [number, number, number]): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 0, 0, 1],
    ifcType: 'IFCWALL',
    geometryClass: 0,
    origin: at,
  };
}

async function makeFixture() {
  // Two far-apart cells → at least two chunks with disjoint AABBs.
  const meshes = [mesh(1, [1, 1, 1]), mesh(2, [2, 2, 2]), mesh(3, [1000, 0, 0])];
  const section = await buildGeometrySectionV13(meshes, coordInfo);
  const open = openGeometryChunksV13(section, 0, 13);
  return { section, chunks: open.chunks };
}

describe('makeColdGeometryProvider', () => {
  it('returns only meshes from chunks intersecting the query bounds (ArrayBuffer source)', async () => {
    const { section, chunks } = await makeFixture();
    const provider = makeColdGeometryProvider({
      source: section,
      geometrySectionOffset: 0,
      chunks,
      version: 13,
    });
    const near = await provider.loadMeshesInBounds([0, 0, 0], [10, 10, 10]);
    assert.deepStrictEqual(near.map((m) => m.expressId).sort(), [1, 2]);
    const far = await provider.loadMeshesInBounds([990, -5, -5], [1010, 5, 5]);
    assert.deepStrictEqual(far.map((m) => m.expressId), [3]);
    const nothing = await provider.loadMeshesInBounds([5000, 5000, 5000], [5001, 5001, 5001]);
    assert.deepStrictEqual(nothing, []);
  });

  it('reads via Blob.slice (partial reads) identically to the buffer source', async () => {
    const { section, chunks } = await makeFixture();
    // Pad the blob with a fake prefix to prove offsets are honoured.
    const prefix = new Uint8Array(128);
    const blob = new Blob([prefix, section]);
    const provider = makeColdGeometryProvider({
      source: blob,
      geometrySectionOffset: 128,
      chunks,
      version: 13,
    });
    const near = await provider.loadMeshesInBounds([0, 0, 0], [10, 10, 10]);
    assert.deepStrictEqual(near.map((m) => m.expressId).sort(), [1, 2]);
    // Second query hits the decoded-chunk LRU (same result, no re-read issues).
    const again = await provider.loadMeshesInBounds([0, 0, 0], [10, 10, 10]);
    assert.deepStrictEqual(again.map((m) => m.expressId).sort(), [1, 2]);
  });
});
