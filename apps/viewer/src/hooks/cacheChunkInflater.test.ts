/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reopen lane, step 2 review: a cache hit loads the inflate pool and starts its
// workers only for an entry that has compressed geometry chunks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import { buildGeometrySectionV13, FORMAT_VERSION, inflateRaw, openGeometryChunksV13 } from '@ifc-lite/cache';
import { createCacheChunkInflater } from './cacheChunkInflater.js';

const coordInfo: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  hasLargeCoordinates: false,
};

/** Compressible meshes in several spatial cells: several chunks above the compression floor. */
const meshes = (): MeshData[] => Array.from({ length: 24 }, (_, i) => ({ expressId: i + 1,
  positions: new Float32Array(3000).map((_, k) => (i % 4) * 400 + (k % 9)), normals: new Float32Array(3000).fill(0.5),
  indices: new Uint32Array(270).map((_, k) => k % 100), color: [0.2, 0.4, 0.6, 1], ifcType: 'IfcWall' }) as MeshData);

/** A stand-in pool module that counts what the inflater asks of it. */
function fakePoolModule() {
  const counts = { loads: 0, pools: 0, starts: 0, inflates: 0, closes: 0 };
  class ChunkInflatePool {
    constructor() { counts.pools++; }
    start() { counts.starts++; return this; }
    inflate = (stored: Uint8Array) => { counts.inflates++; return inflateRaw(stored); };
    close() { counts.closes++; }
  }
  const load = async () => { counts.loads++; return { ChunkInflatePool } as never; };
  return { counts, load };
}

const ids = (list: MeshData[]) => list.map((m) => `${m.expressId}:${m.positions.length}:${m.indices.length}`).join(',');
async function decode(section: ArrayBuffer, options: Parameters<typeof openGeometryChunksV13>[3] = {}) {
  const open = openGeometryChunksV13(section, 0, FORMAT_VERSION, options);
  return (await Promise.all(open.chunks.map((_, i) => open.readChunk(i)))).flat();
}

describe('createCacheChunkInflater', () => {
  it('a metadata-only entry loads no pool and starts no worker', () => {
    const { counts, load } = fakePoolModule();
    const inflater = createCacheChunkInflater(load, 2);
    inflater.prepare(new ArrayBuffer(64), undefined, FORMAT_VERSION);
    inflater.close();
    assert.deepEqual(counts, { loads: 0, pools: 0, starts: 0, inflates: 0, closes: 0 });
  });

  it('an entry whose chunks are all stored raw loads no pool and starts no worker', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: false });
    const { counts, load } = fakePoolModule();
    const inflater = createCacheChunkInflater(load, 2);
    inflater.prepare(section, 0, FORMAT_VERSION);
    assert.equal(ids(await decode(section, { inflate: inflater.inflate })), ids(await decode(section)));
    inflater.close();
    assert.deepEqual(counts, { loads: 0, pools: 0, starts: 0, inflates: 0, closes: 0 });
  });

  it('an entry with compressed chunks starts the pool at the header, once, and inflates them on it', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    const { counts, load } = fakePoolModule();
    const inflater = createCacheChunkInflater(load, 2);
    inflater.prepare(section, 0, FORMAT_VERSION);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual([counts.loads, counts.pools, counts.starts], [1, 1, 1], 'started before any chunk is read');
    assert.equal(ids(await decode(section, { inflate: inflater.inflate })), ids(await decode(section)));
    assert.ok(counts.inflates > 1);
    inflater.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual([counts.loads, counts.pools, counts.closes], [1, 1, 1]);
  });

  it('inflates here when the pool module cannot load', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    const inflater = createCacheChunkInflater(() => Promise.reject(new Error('chunk load failed')), 2);
    const warn = console.warn;
    console.warn = () => {};
    try {
      inflater.prepare(section, 0, FORMAT_VERSION);
      assert.equal(ids(await decode(section, { inflate: inflater.inflate })), ids(await decode(section)));
    } finally {
      console.warn = warn;
      inflater.close();
    }
  });
});
