/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A cache hit loads the decode pool and starts its workers only for an entry with geometry chunks.
// The chunks then inflate AND decode on the workers, ahead of the caller, while the metadata decodes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import { buildGeometrySectionV13, decodeGeometryChunk, FORMAT_VERSION, inflateRaw, openGeometryChunksV13, type GeometryChunkInfo } from '@ifc-lite/cache';
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
/** A pool whose `decode` runs the real decode; `gate` holds every decode until released. */
function fakePoolModule(gate = false) {
  const counts = { loads: 0, pools: 0, starts: 0, inflates: 0, decodes: 0, closes: 0 };
  const held: Array<() => void> = [];
  let closed = false;
  class ChunkInflatePool {
    constructor() { counts.pools++; }
    start() { counts.starts++; return this; }
    inflate = (stored: Uint8Array) => { counts.inflates++; return inflateRaw(stored); };
    decode = async (stored: Uint8Array, info: GeometryChunkInfo, version: number) => {
      counts.decodes++;
      if (gate) await new Promise<void>((resolve) => held.push(resolve));
      if (closed) throw new Error('Geometry compression session closed');
      return decodeGeometryChunk(stored, info, version);
    };
    close() { counts.closes++; closed = true; for (const release of held.splice(0)) release(); }
  }
  const load = async () => { counts.loads++; return { ChunkInflatePool } as never; };
  return { counts, load, release: () => { for (const r of held.splice(0)) r(); } };
}

const ids = (list: MeshData[]) => list.map((m) => `${m.expressId}:${m.positions.length}:${m.indices.length}:${m.positions[0]}`).join(',');
async function decodeAll(section: ArrayBuffer, options: Parameters<typeof openGeometryChunksV13>[3] = {}) {
  const open = openGeometryChunksV13(section, 0, FORMAT_VERSION, options);
  const list: MeshData[] = [];
  for (let i = 0; i < open.chunks.length; i++) list.push(...await open.readChunk(i)); // in order, as the cache hit reads them
  return { list, chunks: open.chunks.length };
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createCacheChunkInflater', () => {
  it('a metadata-only entry loads no pool and starts no worker', () => {
    const { counts, load } = fakePoolModule();
    const inflater = createCacheChunkInflater(load, 2);
    inflater.prepare(new ArrayBuffer(64), undefined, FORMAT_VERSION);
    inflater.close();
    assert.deepEqual(counts, { loads: 0, pools: 0, starts: 0, inflates: 0, decodes: 0, closes: 0 });
  });

  for (const compress of [false, true]) {
    it(`an entry with ${compress ? 'compressed' : 'raw'} chunks starts the pool at the header and decodes every chunk on it, ahead of the caller and once each`, async () => {
      const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress });
      const { counts, load } = fakePoolModule();
      const inflater = createCacheChunkInflater(load, 2);
      inflater.prepare(section, 0, FORMAT_VERSION);
      await turn();
      assert.deepEqual([counts.loads, counts.pools, counts.starts], [1, 1, 1], 'started before any chunk is read');
      const chunks = openGeometryChunksV13(section, 0, FORMAT_VERSION).chunks.length;
      assert.ok(chunks > 1);
      assert.ok(counts.decodes >= Math.min(chunks, 1), 'decoding has begun before the caller asks (the metadata decodes meanwhile)');
      const there = await decodeAll(section, { decode: inflater.decode });
      assert.equal(ids(there.list), ids((await decodeAll(section)).list), 'the same meshes as a main-thread decode');
      assert.equal(counts.decodes, chunks, 'every chunk decoded on the pool, none twice');
      assert.equal(counts.inflates, 0);
      inflater.close();
      await turn();
      assert.equal(counts.closes, 1);
    });
  }

  it('at most two chunks per worker are in flight ahead of the caller', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    const { counts, load, release } = fakePoolModule(true);
    const inflater = createCacheChunkInflater(load, 1);
    inflater.prepare(section, 0, FORMAT_VERSION);
    await turn();
    assert.equal(counts.decodes, 2, 'two in flight for one worker');
    release();
    for (let i = 0; i < 20 && counts.decodes <= 2; i++) await turn();
    assert.ok(counts.decodes > 2, 'each completion starts the next');
    assert.ok(counts.decodes <= 4, 'and still at most two more in flight');
    inflater.close();
  });

  it('a load closed mid-decode (its model removed or replaced) starts no further decode and leaves no unhandled rejection', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    const { counts, load } = fakePoolModule(true);
    const inflater = createCacheChunkInflater(load, 2);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      inflater.prepare(section, 0, FORMAT_VERSION);
      await turn();
      const inFlight = counts.decodes;
      assert.ok(inFlight > 0);
      inflater.close(); // the hit's `finally`: superseded, removed or replaced
      await turn(); await turn();
      assert.equal(counts.decodes, inFlight, 'nothing more is decoded after close');
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('decodes here, as without workers, when the pool module cannot load', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    const inflater = createCacheChunkInflater(() => Promise.reject(new Error('chunk load failed')), 2);
    const warn = console.warn;
    console.warn = () => {};
    try {
      inflater.prepare(section, 0, FORMAT_VERSION);
      assert.equal(ids((await decodeAll(section, { decode: inflater.decode })).list), ids((await decodeAll(section)).list));
    } finally {
      console.warn = warn;
      inflater.close();
    }
  });
});
