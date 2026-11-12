/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A cache hit decodes its geometry chunks on the cache workers, ahead of the caller, while the
// metadata decodes. These tests use the REAL ChunkInflatePool; only its worker is a fake port
// that runs the cache's real handler in this thread and can hold or crash (review of #9925).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import { buildGeometrySectionV13, FORMAT_VERSION, openGeometryChunksV13 } from '@ifc-lite/cache';
import { ChunkInflatePool } from '@ifc-lite/cache/chunk-inflate-pool';
import type { CompressionWorkerPort } from '../../../../packages/cache/src/workers/geometry-compression-client.js';
import { handleCompressionRequest } from '../../../../packages/cache/src/workers/geometry-compression-handler.js';
import { createCacheChunkInflater } from './cacheChunkInflater.js';

const coordInfo: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  hasLargeCoordinates: false,
};

/** Meshes over many spatial cells (one chunk each), sharing one pooled appearance source. */
function meshes(cells = 12): MeshData[] {
  const shared = new Uint32Array(270).map((_, k) => 99 - (k % 100));
  return Array.from({ length: cells * 2 }, (_, i) => {
    const indices = new Uint32Array(270).map((_, k) => k % 100);
    return { expressId: i + 1, positions: new Float32Array(3000).map((_, k) => (i % cells) * 400 + (k % 9)), normals: new Float32Array(3000).fill(0.5),
      indices, color: [0.2, 0.4, 0.6, 1], ifcType: 'IfcWall', geometryItemId: 7000 + i,
      appearanceSource: { kind: 'canonical-item', indices, sourceIndices: shared } } as MeshData;
  });
}

/** A fake worker running the real handler; `hold` keeps replies until `release()`; `crash()` fails it. */
class Port implements CompressionWorkerPort {
  static all: Port[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  decodes = 0;
  private held: Array<() => void> = [];
  constructor(private readonly hold: boolean) { Port.all.push(this); }
  postMessage(message: Parameters<CompressionWorkerPort['postMessage']>[0], transfers: ArrayBuffer[]): void {
    if ('op' in message && message.op === 'decode') this.decodes++;
    const received = structuredClone(message, { transfer: transfers });
    void handleCompressionRequest(received, (response, outgoing) => {
      const deliver = () => this.onmessage?.(new MessageEvent('message', { data: structuredClone(response, { transfer: outgoing }) }));
      if (this.hold) this.held.push(deliver); else deliver();
    });
  }
  release(): void { for (const deliver of this.held.splice(0)) deliver(); }
  crash(): void { this.onerror?.(Object.assign(new Event('error'), { message: 'worker crashed', preventDefault() {} }) as unknown as ErrorEvent); }
  terminate(): void {}
}
const decodesPosted = () => Port.all.reduce((n, p) => n + p.decodes, 0);

/** The real pool module, with fake ports. */
function poolModule(hold = false) {
  Port.all = [];
  let loads = 0;
  class Pool extends ChunkInflatePool {
    constructor(size: number) { super(size, { createWorker: () => new Port(hold) }); }
  }
  const load = async () => { loads++; return { ChunkInflatePool: Pool } as never; };
  return { load, loads: () => loads };
}

const ids = (list: MeshData[]) => list.map((m) => `${m.expressId}:${m.positions.length}:${m.indices.length}:${m.positions[0]}`).join(',');
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
async function readInOrder(open: ReturnType<typeof openGeometryChunksV13>) {
  const list: MeshData[] = [];
  for (let i = 0; i < open.chunks.length; i++) list.push(...await open.readChunk(i)); // as the cache hit reads them
  return list;
}
async function withQuietWarnings<T>(fn: (warnings: unknown[]) => Promise<T>): Promise<T> {
  const warn = console.warn; const warnings: unknown[] = [];
  console.warn = (...a: unknown[]) => { warnings.push(a); };
  try { return await fn(warnings); } finally { console.warn = warn; }
}

describe('createCacheChunkInflater (real pool)', () => {
  it('a metadata-only entry starts no worker', async () => {
    const { load, loads } = poolModule();
    const inflater = createCacheChunkInflater(load, 2);
    inflater.prepare(new ArrayBuffer(64), undefined, FORMAT_VERSION);
    await turn();
    inflater.close();
    assert.equal(loads(), 0);
    assert.equal(Port.all.length, 0);
  });

  it('with the module warmed, the header posts the first chunks at once (before the metadata decode runs), and every chunk decodes on a worker, once', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    const { load } = poolModule();
    const inflater = createCacheChunkInflater(load, 2);
    inflater.warm();
    await turn(); // the module loads while the entry is read
    inflater.prepare(section, 0, FORMAT_VERSION);
    assert.ok(decodesPosted() > 0, 'posted synchronously in prepare, not after the metadata decode');
    const open = inflater.head(section, 0, FORMAT_VERSION);
    assert.equal(ids(await readInOrder(open)), ids(await readInOrder(openGeometryChunksV13(section, 0, FORMAT_VERSION))));
    assert.equal(decodesPosted(), open.chunks.length, 'every chunk on a worker, none twice');
    inflater.close();
  });

  it('closed with chunks in flight: nothing decodes on this thread, no fallback, no warning (review F1)', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    const { load } = poolModule(true);
    await withQuietWarnings(async (warnings) => {
      const inflater = createCacheChunkInflater(load, 2);
      inflater.warm();
      await turn();
      inflater.prepare(section, 0, FORMAT_VERSION);
      const inFlight = decodesPosted();
      assert.ok(inFlight > 0);
      inflater.close(); // superseded, or the model was removed or replaced
      for (const port of Port.all) port.release();
      await turn(); await turn();
      assert.equal(decodesPosted(), inFlight, 'no further decode posted');
      assert.deepEqual(warnings, [], 'no "worker failed, inflating here" fallback');
    });
  });

  it('a worker that fails mid-prefetch stops the work ahead; the caller decodes the rest on demand, unchanged (review F2)', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    const { load } = poolModule(true);
    await withQuietWarnings(async () => {
      const inflater = createCacheChunkInflater(load, 1);
      inflater.warm();
      await turn();
      inflater.prepare(section, 0, FORMAT_VERSION);
      const before = decodesPosted();
      assert.ok(before > 0);
      Port.all[0].crash();
      await turn();
      const open = inflater.head(section, 0, FORMAT_VERSION);
      const list = await readInOrder(open);
      assert.equal(decodesPosted(), before, 'nothing more posted after the failure');
      assert.equal(ids(list), ids(await readInOrder(openGeometryChunksV13(section, 0, FORMAT_VERSION))));
      inflater.close();
    });
  });

  it('a prefetched chunk and one the caller asked for first link to the same appearance-source pool (review F3)', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    const { load } = poolModule();
    const inflater = createCacheChunkInflater(load, 1);
    inflater.warm();
    await turn();
    inflater.prepare(section, 0, FORMAT_VERSION);
    const open = inflater.head(section, 0, FORMAT_VERSION);
    const last = open.chunks.length - 1;
    const onDemand = await open.readChunk(last); // beyond the work ahead: decoded on demand
    const prefetched = await open.readChunk(0);
    const sources = new Set([...onDemand, ...prefetched].map((m) => m.appearanceSource!.sourceIndices));
    assert.equal(sources.size, 1, 'one pool array for both');
    assert.equal(open.chunks[0].appearanceSources!.includes([...sources][0]), true, "it is the shared head's pool");
    inflater.close();
  });

  it('decodes at most four chunks per worker ahead of a caller that takes nothing (review F4)', async () => {
    const section = await buildGeometrySectionV13(meshes(16), coordInfo, { compress: true });
    const { load } = poolModule();
    const inflater = createCacheChunkInflater(load, 1);
    inflater.warm();
    await turn();
    inflater.prepare(section, 0, FORMAT_VERSION);
    for (let i = 0; i < 20; i++) await turn();
    const chunks = inflater.head(section, 0, FORMAT_VERSION).chunks.length;
    assert.ok(chunks > 4);
    assert.equal(decodesPosted(), 4, 'four ahead for one worker, then it waits for the caller');
    await inflater.head(section, 0, FORMAT_VERSION).readChunk(0);
    for (let i = 0; i < 20; i++) await turn();
    assert.equal(decodesPosted(), 5, 'one taken, one more ahead');
    inflater.close();
  });

  it('decodes here, as without workers, when the pool module cannot load', async () => {
    const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
    await withQuietWarnings(async () => {
      const inflater = createCacheChunkInflater(() => Promise.reject(new Error('chunk load failed')), 2);
      inflater.warm();
      inflater.prepare(section, 0, FORMAT_VERSION);
      const open = inflater.head(section, 0, FORMAT_VERSION);
      assert.equal(ids(await readInOrder(open)), ids(await readInOrder(openGeometryChunksV13(section, 0, FORMAT_VERSION))));
      inflater.close();
    });
  });
});
