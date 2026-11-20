/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import { buildGeometrySectionV13, openGeometryChunksV13, FORMAT_VERSION } from '@ifc-lite/cache';
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
  // The reader version is "whatever the writer just emitted", not a literal.
  // It was pinned to 13 and went stale at the #3199 bump: the writer gained 8
  // bytes per mesh record, a v13 reader skipped them, and every record after
  // the first was misaligned -- which `decodeGeometryChunk`'s exact-consumption
  // check caught, but only here, because the cache package's own suite does not
  // run this file. `buildGeometrySectionV13` takes NO version argument: it
  // always writes current, so any literal paired with it is a bet on the
  // format never moving.
  const open = openGeometryChunksV13(section, 0, FORMAT_VERSION);
  return { section, chunks: open.chunks };
}

class ReadCountingBlob extends Blob {
  reads = 0;
  override slice(start?: number, end?: number, contentType?: string): Blob {
    this.reads++;
    return super.slice(start, end, contentType);
  }
}

describe('makeColdGeometryProvider', () => {
  it('returns only meshes from chunks intersecting the query bounds (ArrayBuffer source)', async () => {
    const { section, chunks } = await makeFixture();
    const provider = makeColdGeometryProvider({
      source: section,
      geometrySectionOffset: 0,
      chunks,
      version: FORMAT_VERSION,
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
      version: FORMAT_VERSION,
    });
    const near = await provider.loadMeshesInBounds([0, 0, 0], [10, 10, 10]);
    assert.deepStrictEqual(near.map((m) => m.expressId).sort(), [1, 2]);
    // Second query hits the decoded-chunk LRU (same result, no re-read issues).
    const again = await provider.loadMeshesInBounds([0, 0, 0], [10, 10, 10]);
    assert.deepStrictEqual(again.map((m) => m.expressId).sort(), [1, 2]);
  });

  it('#10264 evicts decoded chunks by backing bytes before the four-entry limit', async () => {
    const section = await buildGeometrySectionV13(
      [mesh(1, [0, 0, 0]), mesh(2, [1000, 0, 0])], coordInfo, { compress: false },
    );
    const open = openGeometryChunksV13(section, 0, FORMAT_VERSION, { sharedArena: true });
    const [sample] = await open.readChunk(0);
    assert.strictEqual(sample.positions.buffer, sample.normals.buffer);
    assert.strictEqual(sample.positions.buffer, sample.indices.buffer);
    const source = new ReadCountingBlob([section]);
    const provider = makeColdGeometryProvider({ source, chunks: open.chunks,
      geometrySectionOffset: 0, version: FORMAT_VERSION,
      decodedCacheBytes: sample.positions.buffer.byteLength });
    const first = await provider.loadMeshesInBounds([0, 0, 0], [2, 2, 2]);
    const hit = await provider.loadMeshesInBounds([0, 0, 0], [2, 2, 2]);
    assert.strictEqual(hit[0], first[0], 'one shared arena fits and must stay cached');
    assert.equal(source.reads, 1);
    const far = await provider.loadMeshesInBounds([1000, 0, 0], [1002, 2, 2]);
    assert.deepEqual(far.map(m => m.expressId), [2]);
    const restored = await provider.loadMeshesInBounds([0, 0, 0], [2, 2, 2]);
    assert.equal(source.reads, 3, 'the first chunk must be read back after byte eviction');
    assert.notStrictEqual(restored[0], first[0]);
    assert.deepEqual(restored[0].positions, first[0].positions);
  });

  it('#10264 returns oversized chunks without evicting a useful small neighbour', async () => {
    const large = mesh(2, [1000, 0, 0]);
    large.positions = new Float32Array(3000);
    large.normals = new Float32Array(3000);
    const section = await buildGeometrySectionV13([mesh(1, [0, 0, 0]), large], coordInfo);
    const open = openGeometryChunksV13(section, 0, FORMAT_VERSION);
    const source = new ReadCountingBlob([section]);
    const provider = makeColdGeometryProvider({ source, chunks: open.chunks,
      geometrySectionOffset: 0, version: FORMAT_VERSION, decodedCacheBytes: 1024 });
    const small = await provider.loadMeshesInBounds([0, 0, 0], [2, 2, 2]);
    const firstLarge = await provider.loadMeshesInBounds([1000, 0, 0], [1002, 2, 2]);
    const nextLarge = await provider.loadMeshesInBounds([1000, 0, 0], [1002, 2, 2]);
    assert.equal(firstLarge[0].positions.length, 3000);
    assert.notStrictEqual(firstLarge[0], nextLarge[0], 'oversized chunks cannot stay in the LRU');
    const againSmall = await provider.loadMeshesInBounds([0, 0, 0], [2, 2, 2]);
    assert.strictEqual(againSmall[0], small[0]);
    assert.equal(source.reads, 3);
  });

  it('#10264 a zero budget disables decoded retention while preserving readback', async () => {
    const { section, chunks } = await makeFixture();
    const source = new ReadCountingBlob([section]);
    const provider = makeColdGeometryProvider({ source, chunks, geometrySectionOffset: 0,
      version: FORMAT_VERSION, decodedCacheBytes: 0 });
    const first = await provider.loadMeshesInBounds([0, 0, 0], [10, 10, 10]);
    const next = await provider.loadMeshesInBounds([0, 0, 0], [10, 10, 10]);
    assert.equal(source.reads, 2);
    assert.notStrictEqual(first[0], next[0]);
    assert.deepEqual(first, next);
  });

  it('#10264 rejects invalid cache budgets instead of silently losing the byte bound', async () => {
    const { section, chunks } = await makeFixture();
    for (const decodedCacheBytes of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => makeColdGeometryProvider({ source: section, chunks,
        geometrySectionOffset: 0, version: FORMAT_VERSION, decodedCacheBytes }), RangeError);
    }
  });
});
